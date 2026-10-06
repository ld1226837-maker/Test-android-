package app.tauri.androidsave

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.content.SharedPreferences
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.FileProvider
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class SaveArgs {
    lateinit var fileName: String
    lateinit var mimeType: String
    lateinit var base64: String
    /** Open the saved file in a viewer afterwards (used by Print). */
    var openAfterSave: Boolean = false
}

@InvokeArg
class CopyUriArgs {
    lateinit var uri: String
    lateinit var fileName: String
}

@InvokeArg
class DeletePrivateFileArgs {
    lateinit var path: String
}

@InvokeArg
class SecureSetArgs {
    lateinit var key: String
    lateinit var value: String
}

@InvokeArg
class SecureKeyArgs {
    lateinit var key: String
}

@TauriPlugin
class AndroidSavePlugin(private val activity: Activity) : Plugin(activity) {

    /**
     * Writes the bytes into the device's public Downloads folder.
     *
     * API 29+ : MediaStore.Downloads insert + OutputStream (no permission needed,
     *           and unlike direct filesystem writes it is not silently blocked,
     *           which is what left 0-byte files behind).
     * API 24-28: legacy direct write to the public Downloads directory.
     */
    /** Removes MediaStore exports left pending by a process death. Only rows owned by this package are touched. */
    @Command
    fun cleanupPendingExports(invoke: Invoke) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val resolver = activity.contentResolver
                val uri = MediaStore.Downloads.EXTERNAL_CONTENT_URI
                val projection = arrayOf(MediaStore.MediaColumns._ID)
                val selection = "${MediaStore.MediaColumns.IS_PENDING}=1 AND ${MediaStore.MediaColumns.OWNER_PACKAGE_NAME}=?"
                resolver.query(uri, projection, selection, arrayOf(activity.packageName), null)?.use { c ->
                    val id = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                    while (c.moveToNext()) {
                        val item = Uri.withAppendedPath(uri, c.getLong(id).toString())
                        resolver.delete(item, null, null)
                    }
                }
            }
            invoke.resolve()
        } catch (e: Exception) {
            // Cleanup is best-effort; never prevent the app from starting.
            invoke.resolve()
        }
    }

    @Command
    fun openPrivateFile(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SaveArgs::class.java)
            val bytes = Base64.decode(args.base64, Base64.DEFAULT)
            if (bytes.isEmpty()) {
                invoke.reject("refusing to open an empty file")
                return
            }
            val dir = File(activity.cacheDir, "receipt-view").apply { mkdirs() }
            val safeName = args.fileName.replace(Regex("[^A-Za-z0-9._-]"), "_")
            val target = File(dir, "${System.currentTimeMillis()}-$safeName")
            target.outputStream().use { it.write(bytes) }
            val authority = "${activity.packageName}.fileprovider"
            val uri = FileProvider.getUriForFile(activity, authority, target)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, args.mimeType)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            Handler(Looper.getMainLooper()).postDelayed({
                try { target.delete() } catch (ignored: Exception) {}
            }, 60_000L)
            val result = JSObject()
            result.put("uri", uri.toString())
            result.put("bytesWritten", bytes.size.toLong())
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun saveToDownloads(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SaveArgs::class.java)
            val bytes = Base64.decode(args.base64, Base64.DEFAULT)
            if (bytes.isEmpty()) {
                invoke.reject("refusing to save an empty file")
                return
            }

            val uriString: String
            var written = 0L

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val resolver = activity.contentResolver
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, args.fileName)
                    put(MediaStore.MediaColumns.MIME_TYPE, args.mimeType)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: run {
                        invoke.reject("MediaStore refused to create the file")
                        return
                    }
                resolver.openOutputStream(uri)?.use { out ->
                    out.write(bytes)
                    out.flush()
                    written = bytes.size.toLong()
                } ?: run {
                    resolver.delete(uri, null, null)
                    invoke.reject("could not open an output stream for the new file")
                    return
                }
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                uriString = uri.toString()

                if (args.openAfterSave) openUri(uri.toString(), args.mimeType, false)
            } else {
                val dir = Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOWNLOADS
                )
                if (!dir.exists()) dir.mkdirs()
                val target = uniqueFile(dir, args.fileName)
                target.outputStream().use { it.write(bytes) }
                written = target.length()
                uriString = target.absolutePath
                if (args.openAfterSave) openFile(target, args.mimeType)
            }

            if (written == 0L) {
                invoke.reject("file was created but nothing was written")
                return
            }

            val result = JSObject()
            result.put("uri", uriString)
            result.put("bytesWritten", written)
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    /**
     * Backing store for secureSet/secureGet/secureDelete: a SharedPreferences
     * file whose keys AND values are encrypted with a Keystore-derived
     * AES256-GCM master key (`EncryptedSharedPreferences`). This is what the
     * Telegram bot token (and the backup passphrase) get moved into on
     * Android instead of plaintext `localStorage` (audit item 1.3) — the
     * desktop build already has an equivalent via `keyring_*` (OS credential
     * store), which has no Android counterpart; this is that counterpart.
     *
     * Created lazily (not in a field initializer) so a Keystore failure
     * surfaces as a rejected command the TS caller can fall back from,
     * rather than crashing plugin registration.
     */
    private fun securePrefs(): SharedPreferences {
        try {
            return createSecurePrefs()
        } catch (first: Exception) {
            // The prefs file can survive (app restore / data transfer) while its
            // Keystore master key does not; the stored values are unreadable
            // then, so reset the file and key once instead of failing forever.
            try {
                activity.deleteSharedPreferences("turf_ledger_secure_prefs")
            } catch (ignored: Exception) {
            }
            try {
                val ks = java.security.KeyStore.getInstance("AndroidKeyStore")
                ks.load(null)
                ks.deleteEntry("_androidx_security_master_key_")
            } catch (ignored: Exception) {
            }
            return createSecurePrefs()
        }
    }

    private fun createSecurePrefs(): SharedPreferences {
        val masterKey = MasterKey.Builder(activity)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            activity,
            "turf_ledger_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    /**
     * Same defense-in-depth principle as desktop's `keyring_*` commands (see
     * `src-tauri/src/lib.rs`): `key` is checked against a fixed allowlist
     * rather than trusted as an arbitrary caller-supplied name, so a script
     * running in the webview can't use this as a general encrypted
     * key/value store for anything it likes.
     */
    private val allowedSecureKeys = setOf(
        "telegram-backup-token",
        "telegram-backup-extra-tokens",
        "backup-passphrase",
    )

    private fun checkSecureKey(key: String) {
        require(allowedSecureKeys.contains(key)) { "unknown credential slot" }
    }

    /** Stores one secret under `key`, replacing any existing value. */
    @Command
    fun copyUriToPrivateFile(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CopyUriArgs::class.java)
            val source = Uri.parse(args.uri)
            val safeName = args.fileName.replace(Regex("[^A-Za-z0-9._-]"), "_")
            val dir = File(activity.filesDir, "TurfApp/imports").apply { mkdirs() }
            val target = File(dir, safeName)
            activity.contentResolver.openInputStream(source)?.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(1024 * 1024)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        if (n > 0) output.write(buffer, 0, n)
                    }
                    output.flush()
                }
            } ?: throw IllegalStateException("could not open the selected document")
            if (!target.exists() || target.length() == 0L) { target.delete(); throw IllegalStateException("selected document is empty") }
            invoke.resolve(target.absolutePath)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun deletePrivateFile(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(DeletePrivateFileArgs::class.java)
            val root = File(activity.filesDir, "TurfApp/imports").canonicalFile
            val target = File(args.path).canonicalFile
            if (!target.path.startsWith(root.path + File.separator)) throw IllegalArgumentException("invalid private import path")
            target.delete()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun secureSet(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecureSetArgs::class.java)
            checkSecureKey(args.key)
            if (!securePrefs().edit().putString(args.key, args.value).commit()) {
                invoke.reject("secure store write was not committed")
                return
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    /** Returns the stored secret for `key`, or null in `value` if unset. */
    @Command
    fun secureGet(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecureKeyArgs::class.java)
            checkSecureKey(args.key)
            val result = JSObject()
            result.put("value", securePrefs().getString(args.key, null))
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    /** Removes the stored secret for `key`, if any. Never rejects on "already absent". */
    @Command
    fun secureDelete(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecureKeyArgs::class.java)
            checkSecureKey(args.key)
            securePrefs().edit().remove(args.key).commit()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    private fun uniqueFile(dir: File, name: String): File {
        var candidate = File(dir, name)
        if (!candidate.exists()) return candidate
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var i = 1
        while (candidate.exists()) {
            candidate = File(dir, "$stem ($i)$ext")
            i++
        }
        return candidate
    }

    private fun openUri(uri: String, mimeType: String, grantWrite: Boolean) {
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(android.net.Uri.parse(uri), mimeType)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            if (grantWrite) addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        runCatching { activity.startActivity(intent) }
    }

    private fun openFile(file: File, mimeType: String) {
        val uri = runCatching {
            FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        }.getOrNull() ?: android.net.Uri.fromFile(file)
        openUri(uri.toString(), mimeType, false)
    }
}

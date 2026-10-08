// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Radix primitives expect these in a real browser.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn(), warning: vi.fn() },
}));

// Platform switches — everything else in ./desktop stays real.
const platform = { android: false, desktop: false };
const { printPdfFile } = vi.hoisted(() => ({
  printPdfFile: vi.fn(async (..._args: unknown[]) => ({ printed: true })),
}));
vi.mock("./desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./desktop")>();
  return {
    ...actual,
    isAndroid: () => platform.android,
    isDesktop: () => platform.desktop,
    printPdfFile,
  };
});

const { printReceipt } = await import("./receipt");
const { sampleDocument } = await import("./document-samples");
const { DEFAULT_PRINT_SETTINGS } = await import("./print");
const { PrintSettingsCard } =
  await import("@/components/app/PrintSettingsCard");
const { PrintPreviewDialog } =
  await import("@/components/app/PrintPreviewDialog");

type Method = "system" | "pdf" | "named-printer";
const withMethod = (printMethod: Method) => ({
  ...DEFAULT_PRINT_SETTINGS,
  printMethod,
  selectedPrinter: "Some Windows Printer",
});

describe("printReceipt on Android always uses the native print dialog", () => {
  let openSpy: ReturnType<typeof vi.spyOn>;
  let appended: HTMLElement[];

  beforeEach(() => {
    toastError.mockReset();
    printPdfFile.mockClear();
    appended = [];
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const realAppend = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation(((
      el: HTMLElement,
    ) => {
      if (el.tagName === "IFRAME") {
        appended.push(el);
        // Settle the print promise immediately instead of waiting 20 s.
        queueMicrotask(() => el.onload?.(new Event("load")));
        return el;
      }
      return realAppend(el);
    }) as typeof document.body.appendChild);
    // The frame's print() "succeeds" and fires afterprint.
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
      configurable: true,
      get() {
        return {
          focus() {},
          addEventListener: (_: string, cb: () => void) => queueMicrotask(cb),
          print() {},
        };
      },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  for (const method of ["pdf", "named-printer"] as const) {
    it(`Android ignores a saved "${method}" setting`, async () => {
      platform.android = true;
      platform.desktop = true; // Tauri Android reports isDesktop() === true
      await printReceipt(sampleDocument("sales"), withMethod(method));
      expect(printPdfFile).toHaveBeenCalledTimes(1); // native PrintManager
      expect(appended.length).toBe(0); // never the iframe path
      expect(openSpy).not.toHaveBeenCalled(); // no PDF window
      expect(toastError).not.toHaveBeenCalled(); // no "needs Windows" error
    });
  }

  it("control: off Android, a saved 'named-printer' still hits the Windows-only error", async () => {
    platform.android = false;
    platform.desktop = false;
    await printReceipt(sampleDocument("sales"), withMethod("named-printer"));
    expect(toastError).toHaveBeenCalledWith(
      "Direct printer selection needs the Windows desktop app",
      expect.anything(),
    );
  });

  it("control: off Android, 'pdf' still opens the PDF window", async () => {
    platform.android = false;
    platform.desktop = false;
    await printReceipt(sampleDocument("sales"), withMethod("pdf"));
    expect(openSpy).toHaveBeenCalled();
  });
});

describe("Print method UI is Windows-only", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  async function renderSettings() {
    await act(async () => {
      root.render(createElement(PrintSettingsCard));
    });
    return document.body.textContent ?? "";
  }

  it("Settings: Android hides the Print method selector and printer picker", async () => {
    platform.android = true;
    platform.desktop = true;
    const text = await renderSettings();
    expect(text).toContain("Feed before cut"); // card did render
    expect(text).not.toContain("Print method");
    expect(text).not.toContain("PDF print");
    expect(text).not.toContain("Chosen printer");
  });

  it("Settings: Windows still shows it", async () => {
    platform.android = false;
    platform.desktop = true;
    const text = await renderSettings();
    expect(text).toContain("Print method");
    expect(text).toContain("PDF print");
    expect(text).toContain("Chosen printer");
  });

  async function renderDialog() {
    await act(async () => {
      root.render(
        createElement(PrintPreviewDialog, {
          request: { doc: sampleDocument("sales"), section: undefined },
          onOpenChange: () => {},
        }),
      );
    });
    return document.body.textContent ?? "";
  }

  it("Preview dialog: Android hides the per-print Print method toggle", async () => {
    platform.android = true;
    platform.desktop = true;
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    const text = await renderDialog();
    expect(text).toMatch(/copies/i); // dialog did render
    expect(text).not.toContain("Print method");
  });

  it("Preview dialog: Windows still shows it", async () => {
    platform.android = false;
    platform.desktop = true;
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    const text = await renderDialog();
    expect(text).toContain("Print method");
  });
});

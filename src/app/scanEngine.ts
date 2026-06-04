/**
 * QR decode fallback for browsers without a native `BarcodeDetector` (iOS Safari, Firefox,
 * desktop Linux Chrome). Wraps the zxing-wasm-backed `barcode-detector` ponyfill.
 *
 * This module is imported DYNAMICALLY (only on the scan path, only when the native API is
 * missing) so its ~code + wasm never load on browsers that have the native detector. The
 * wasm is self-hosted (bundled via `?url`) instead of zxing's default jsDelivr CDN, so it
 * works on flaky wifi / offline and is cached by the service worker like any static asset.
 */
import { BarcodeDetector, prepareZXingModule } from "barcode-detector/ponyfill";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

let configured = false;

export function getPonyfillDetector(): BarcodeDetector {
  if (!configured) {
    // Register the self-hosted wasm location without instantiating yet (deferred to the
    // first detect). `fireImmediately: false` is the non-deprecated way to set overrides.
    prepareZXingModule({
      overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
      fireImmediately: false,
    });
    configured = true;
  }
  return new BarcodeDetector({ formats: ["qr_code"] });
}

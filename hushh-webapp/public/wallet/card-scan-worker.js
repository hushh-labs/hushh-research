/* Own Tesseract's nested worker so cancellation also stops pending initialization. */
/* global importScripts, Tesseract */
self.onmessage = async (event) => {
  self.onmessage = null;
  let worker;
  const fail = () => self.postMessage({ error: "scan_failed" });
  try {
    importScripts("/vendor/wallet-ocr/tesseract.min.js");
    const base = new URL("/vendor/wallet-ocr/", self.location.href).href;
    worker = await Tesseract.createWorker("eng", 1, {
      workerPath: base + "worker.min.js", corePath: base,
      langPath: base.replace(/\/$/, ""), cacheMethod: "none",
      workerBlobURL: false, logger: () => {}, errorHandler: fail,
    });
    await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
    const result = await worker.recognize(event.data);
    self.postMessage({ text: result.data.text });
  } catch {
    fail();
  } finally {
    await worker?.terminate();
  }
};

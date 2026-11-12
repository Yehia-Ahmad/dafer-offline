// Stage 23: the browser-side helpers of printing: measuring an 80mm receipt, and the dev-browser fallback
// (window.print() of a hidden iframe). The Electron path never needs the second one.

const PX_PER_MM = 96 / 25.4;

function hiddenFrame(html: string, widthCss: string): Promise<HTMLIFrameElement> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthCss};height:200px;border:0;visibility:hidden`;
    frame.onload = () => resolve(frame);
    frame.onerror = () => reject(new Error('print frame failed to load'));
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

/** The height of an 80mm receipt in whole millimetres (the page of a roll is as tall as the receipt). */
export async function measureRollHeightMm(html: string): Promise<number> {
  const frame = await hiddenFrame(html, '80mm');
  try {
    const doc = frame.contentDocument;
    if (doc && doc.fonts && doc.fonts.ready) await doc.fonts.ready;
    // Barcode and images are inline SVG / data: URIs: nothing else to wait for.
    const height = doc ? Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight) : 0;
    return Math.ceil(height / PX_PER_MM) + 2;
  } finally {
    frame.remove();
  }
}

/** Dev browser only: print the document through a hidden iframe (the browser's own print dialog; "Save as PDF" is there). */
export async function printInFrame(html: string): Promise<void> {
  const frame = await hiddenFrame(html, '210mm');
  frame.style.visibility = 'visible';
  const win = frame.contentWindow;
  if (!win) {
    frame.remove();
    throw new Error('print frame has no window');
  }
  const cleanup = () => setTimeout(() => frame.remove(), 500);
  win.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(cleanup, 120000);
  const doc = frame.contentDocument;
  if (doc && doc.fonts && doc.fonts.ready) await doc.fonts.ready;
  win.focus();
  win.print();
}

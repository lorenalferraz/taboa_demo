/**
 * Se o popup encostar na barra superior, abre abaixo do ponto clicado.
 */
function headerBottomPx() {
  const bar = document.querySelector('.topbar');
  return bar ? bar.getBoundingClientRect().bottom : 56;
}

function resetPopupFlip(el) {
  if (!el) return;
  el.classList.remove('popup-below');
  delete el.dataset.popupFlipped;
}

function flipPopupBelow(el) {
  if (!el || el.dataset.popupFlipped === '1') return;
  const h = el.offsetHeight;
  const bottom = parseFloat(el.style.bottom) || 0;
  el.classList.add('popup-below');
  el.style.bottom = `${bottom - h - 40}px`;
  el.dataset.popupFlipped = '1';
}

export function setupMapPopupPlacement(map) {
  if (!map) return;
  map.on('popupopen', (e) => {
    const popup = e.popup;
    const el = popup?.getElement();
    if (!el) return;
    resetPopupFlip(el);
    requestAnimationFrame(() => {
      const node = popup.getElement();
      if (!node) return;
      const rect = node.getBoundingClientRect();
      if (rect.top < headerBottomPx() + 8) flipPopupBelow(node);
    });
  });
}

// Inicialización de Google Analytics en archivo propio para no necesitar
// 'unsafe-inline' en la Content-Security-Policy.
window.dataLayer = window.dataLayer || [];
function gtag() {
  window.dataLayer.push(arguments);
}
gtag('js', new Date());
gtag('config', 'G-6X9XM5SDEE');

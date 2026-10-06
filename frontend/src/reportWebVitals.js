/**
 * Web Vitals (CLS, LCP, INP, TTFB) — console em dev; beacon opcional em produção.
 * No Vercel: ative Web Analytics no dashboard do projeto para painel oficial.
 * Pós-deploy: rode Lighthouse no Chrome DevTools (LCP / CLS / INP).
 */
export function reportWebVitals() {
  import('web-vitals')
    .then(({ onCLS, onINP, onLCP, onTTFB, onFCP }) => {
      const send = (metric) => {
        const payload = {
          name: metric.name,
          value: Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value),
          rating: metric.rating,
          id: metric.id,
        };
        if (import.meta.env.DEV) {
          console.info('[web-vitals]', payload.name, payload.value, payload.rating);
          return;
        }
        // Opcional: enviar para endpoint próprio / analytics
        // if (navigator.sendBeacon) navigator.sendBeacon('/api/vitals', JSON.stringify(payload));
        console.info('[web-vitals]', payload.name, payload.value, payload.rating);
      };
      onCLS(send);
      onINP(send);
      onLCP(send);
      onTTFB(send);
      onFCP(send);
    })
    .catch((e) => console.warn('[web-vitals] não carregou:', e));
}

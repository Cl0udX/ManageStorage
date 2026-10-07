// Traduce el "user agent" del navegador a algo que una persona entienda: "iPhone · iOS 18.7 · Safari".
export function parseUserAgent(ua = '') {
  const s = String(ua);
  let device = null, os = null, m;
  if (/iPhone/.test(s)) { device = 'iPhone'; m = /iPhone OS (\d+)[_.](\d+)/.exec(s); os = m ? `iOS ${m[1]}.${m[2]}` : 'iOS'; }
  else if (/iPad/.test(s)) { device = 'iPad'; m = /OS (\d+)[_.](\d+)/.exec(s); os = m ? `iPadOS ${m[1]}.${m[2]}` : 'iPadOS'; }
  else if (/Android/.test(s)) {
    m = /Android ([\d.]+)(?:; ([^;)]+))?/.exec(s);
    const model = m?.[2]?.trim();
    device = model && !/^(Mobile|wv|K)$/.test(model) ? `Android ${model}` : 'Android';
    os = m ? `Android ${m[1]}` : null;
  } else if (/Windows/.test(s)) device = 'Windows';
  else if (/CrOS/.test(s)) device = 'Chromebook';
  else if (/Macintosh|Mac OS X/.test(s)) { device = 'Mac'; os = 'macOS'; }
  else if (/Linux/.test(s)) device = 'Linux';
  const browser = /EdgiOS|EdgA|Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet'
    : /FxiOS|Firefox/.test(s) ? 'Firefox' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : null;
  return [device, os !== device ? os : null, browser].filter(Boolean).join(' · ') || null;
}

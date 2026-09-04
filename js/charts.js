/* ============================================================
   charts.js — SVG-графики без внешних библиотек.
   Отдают разметку строкой; вставкой в DOM занимается ui.js.
   ============================================================ */
const Charts = (() => {
  'use strict';

  // Широкий viewBox: график стоит во всю ширину, подписи при растяжении не раздуваются.
  const W = 1200, H = 440;
  const PAD = { top: 34, right: 64, bottom: 40, left: 44 };
  const PLOT_W = W - PAD.left - PAD.right;
  const PLOT_H = H - PAD.top - PAD.bottom;

  /** Красивая верхняя граница шкалы: 0→5→10→20→25… */
  function niceMax(value) {
    if (!value || value <= 0) return 4;
    const steps = [1, 2, 2.5, 5, 10];
    const mag = Math.pow(10, Math.floor(Math.log10(value)));
    for (const s of steps) { if (s * mag >= value) return s * mag; }
    return 10 * mag;
  }

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const f1 = n => n.toFixed(1);

  /**
   * Поток инцидентов: приток и разбор парными столбиками от общей базы,
   * очередь на конец периода — линией по правой шкале.
   *
   * Парные столбики вместо зеркальных: сравнивать высоты, растущие из одной
   * точки, глазу проще, чем длины вверх и вниз от нуля. Текущий период
   * (последний в ряду) подсвечен полосой: клик по любому другому его меняет,
   * и должно быть видно, где ты сейчас.
   *
   * @param {Array} series [{ label, created, fixed, openAtEnd }]
   * @param {number} [activeIndex] какой период сейчас выбран; по умолчанию последний
   */
  function flow(series, activeIndex = series.length - 1) {
    if (!series.length) return '';
    const barMax = niceMax(Math.max(1, ...series.map(p => Math.max(p.created, p.fixed))));
    const backMax = niceMax(Math.max(1, ...series.map(p => p.openAtEnd)));

    const baseY = PAD.top + PLOT_H;
    const step = PLOT_W / series.length;
    const barW = Math.min(40, step * 0.28);
    const gap = 4;

    const xMid = i => PAD.left + step * i + step / 2;
    const yBar = v => baseY - (v / barMax) * (PLOT_H - 24);
    const yBack = v => baseY - (v / backMax) * (PLOT_H - 24);

    const parts = [];

    // Подсветка выбранного периода — под всем остальным
    if (activeIndex >= 0 && activeIndex < series.length) {
      parts.push(`<rect class="flow-active" x="${f1(PAD.left + step * activeIndex)}" y="${PAD.top - 10}" width="${f1(step)}" height="${PLOT_H + 10}" rx="10"/>`);
    }

    // Сетка и левая шкала: три деления, без рамки
    [0.25, 0.5, 0.75, 1].forEach(k => {
      const y = baseY - (PLOT_H - 24) * k;
      parts.push(`<line class="grid-line" x1="${PAD.left}" y1="${f1(y)}" x2="${W - PAD.right}" y2="${f1(y)}"/>`);
      parts.push(`<text x="${PAD.left - 8}" y="${f1(y + 4)}" text-anchor="end">${Math.round(barMax * k)}</text>`);
      parts.push(`<text class="axis-right" x="${W - PAD.right + 8}" y="${f1(y + 4)}" text-anchor="start">${Math.round(backMax * k)}</text>`);
    });
    parts.push(`<line class="zero" x1="${PAD.left}" y1="${baseY}" x2="${W - PAD.right}" y2="${baseY}"/>`);
    parts.push(`<text class="axis-title" x="${PAD.left - 8}" y="${PAD.top - 14}" text-anchor="end">шт</text>`);
    parts.push(`<text class="axis-title axis-right" x="${W - PAD.right + 8}" y="${PAD.top - 14}" text-anchor="start">очередь</text>`);

    // Заливка под линией очереди — под столбиками
    const line = series.map((p, i) => `${i ? 'L' : 'M'}${f1(xMid(i))},${f1(yBack(p.openAtEnd))}`).join(' ');
    parts.push(`<path class="backlog-area" d="${line} L${f1(xMid(series.length - 1))},${baseY} L${f1(xMid(0))},${baseY} Z"/>`);

    series.forEach((p, i) => {
      const x = xMid(i);
      const xUp = x - barW - gap / 2, xDn = x + gap / 2;
      const yUp = yBar(p.created), yDn = yBar(p.fixed);
      parts.push(`<rect class="bar-up" x="${f1(xUp)}" y="${f1(yUp)}" width="${f1(barW)}" height="${f1(baseY - yUp)}" rx="4"/>`);
      parts.push(`<rect class="bar-dn" x="${f1(xDn)}" y="${f1(yDn)}" width="${f1(barW)}" height="${f1(baseY - yDn)}" rx="4"/>`);
      // Числа над столбиками: на встрече их называют вслух, а не измеряют по шкале
      parts.push(`<text class="bar-val" x="${f1(xUp + barW / 2)}" y="${f1(yUp - 7)}" text-anchor="middle">${p.created}</text>`);
      parts.push(`<text class="bar-val" x="${f1(xDn + barW / 2)}" y="${f1(yDn - 7)}" text-anchor="middle">${p.fixed}</text>`);
      parts.push(`<text class="${i === activeIndex ? 'axis-active' : ''}" x="${f1(x)}" y="${H - 12}" text-anchor="middle">${esc(p.label)}</text>`);
      parts.push(`<rect class="bar-hit" data-flow="${i}" x="${f1(PAD.left + step * i)}" y="${PAD.top - 10}" width="${f1(step)}" height="${PLOT_H + 10}">` +
        `<title>${esc(p.label)} · пришло ${p.created}, разобрано ${p.fixed}, в очереди ${p.openAtEnd}</title></rect>`);
    });

    parts.push(`<path class="backlog-line" d="${line}"/>`);
    series.forEach((p, i) => {
      parts.push(`<circle class="backlog-dot" cx="${f1(xMid(i))}" cy="${f1(yBack(p.openAtEnd))}" r="${i === activeIndex ? 5.5 : 3.5}"/>`);
      parts.push(`<text class="backlog-val" x="${f1(xMid(i))}" y="${f1(yBack(p.openAtEnd) - 11)}" text-anchor="middle">${p.openAtEnd}</text>`);
    });

    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Поток инцидентов по периодам">${parts.join('')}</svg>`;
  }

  /** Воронка когорты: как далеко дошло то, что пришло за период. */
  function funnel(cohort) {
    const steps = [
      { label: 'Создано',    value: cohort.n,       color: 'var(--faint)' },
      { label: 'В работе',   value: cohort.started, color: 'var(--accent)' },
      { label: 'Исправлено', value: cohort.fixed,   color: 'var(--green)' },
      { label: 'Закрыто',    value: cohort.closed,  color: 'var(--teal)' },
    ];
    const max = Math.max(1, cohort.n);
    return '<div class="funnel">' + steps.map(s => {
      const pct = Math.round((s.value / max) * 100);
      return `<div class="funnel__row"><span>${s.label}</span>` +
        `<span class="funnel__bar"><i style="width:${(s.value / max) * 100}%;background:${s.color}"></i></span>` +
        `<span class="funnel__val">${s.value}<em>${pct}%</em></span></div>`;
    }).join('') + '</div>';
  }

  return { flow, funnel, niceMax };
})();

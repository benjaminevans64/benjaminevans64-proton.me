/* Rating Stress Test: розрахунок рейтингу у браузері + AI-пояснення (Worker). Дані: #rst-config. */
(function () {
  'use strict';
  var root = document.getElementById('rst-app');
  var cfgEl = document.getElementById('rst-config');
  if (!root || !cfgEl) return;
  var cfg;
  try { cfg = JSON.parse(cfgEl.textContent); } catch (e) { return; }

  var ENDPOINT = cfg.api || '/api/rating-stress/';
  // Локальна перевірка: сторінка з нестандартним портом ходить на локальний Worker.
  if (location.port && /^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
    ENDPOINT = location.protocol + '//' + location.hostname + ':' + (cfg.localPort || 8851) + ENDPOINT;
  }
  var PRIOR = 3.5, PRIOR_W = 20;
  var state = { counts: cfg.presets[0].counts.slice(), stress: 0, voice: cfg.voices[0].slug, busy: false };

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(n) { return n.toLocaleString('en-US'); }

  function metrics(c) {
    var n = c[0] + c[1] + c[2] + c[3] + c[4];
    if (n < 1) return null;
    var sum = c[0] + 2 * c[1] + 3 * c[2] + 4 * c[3] + 5 * c[4];
    var p = (c[3] + c[4]) / n, z = 1.96;
    var wilson = (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n);
    return { n: n, sum: sum, mean: sum / n, adjusted: (PRIOR * PRIOR_W + sum) / (PRIOR_W + n), p: p, wilson: Math.max(0, wilson), five: c[4] / n, one: c[0] / n };
  }
  function shape(m) {
    if (m.n < 30) return { key: 'thin', label: 'Thin evidence' };
    if (m.five >= 0.9) return { key: 'uniform', label: 'Unusually uniform' };
    if (m.one >= 0.12 && m.five >= 0.45) return { key: 'split', label: 'Split opinions' };
    if (m.mean >= 3.8) return { key: 'broad', label: 'Broad and positive' };
    return { key: 'low', label: 'Lukewarm or low' };
  }
  function fragility(m) {
    if (m.mean < 4) return null;
    return Math.max(1, Math.floor((m.sum - 4 * m.n) / 3) + 1);
  }
  var PIN = {
    thin: 'With so few reviews, one or two opinions can move the score a long way. Treat the number as a first impression, not a measurement.',
    uniform: 'Almost every review gives the top score. That can be genuine, but it leaves no spread to learn from, so it is worth checking how reviews are collected and whether low scores are ever shown.',
    split: 'Many people love it and a real share are unhappy. The average hides that split, so read the low-star reviews to find out what went wrong for them.',
    broad: 'Praise is spread across 4 and 5 stars with some lower scores, which is what a large, varied set of experiences usually looks like.',
    low: 'The scores sit in the middle or below. Look at what reviewers say about price, wait time and refunds before deciding.'
  };

  /* ---------- розмітка ---------- */
  root.innerHTML = '';
  var ledger = el('section', 'rst-ledger');
  ledger.innerHTML = '<p class="rst-step">Step 1</p><h2>Enter the star counts</h2><p class="rst-lead">Copy the number of reviews at each star level from any rating you are weighing up, or start from an example.</p>';
  var presets = el('div', 'rst-presets');
  cfg.presets.forEach(function (pr) {
    var b = el('button', 'rst-chip', esc(pr.name)); b.type = 'button';
    b.addEventListener('click', function () { state.counts = pr.counts.slice(); state.stress = 0; syncInputs(); render(); });
    presets.appendChild(b);
  });
  ledger.appendChild(presets);
  var rows = [];
  var rowsWrap = el('div', 'rst-rows');
  for (var s = 5; s >= 1; s--) {
    (function (star) {
      var i = star - 1;
      var row = el('div', 'rst-row');
      var lab = el('label', 'rst-star', '<b>' + star + '</b><span aria-hidden="true">&#9733;</span><span class="rst-sr"> star reviews</span>');
      var inp = el('input', 'rst-num'); inp.type = 'number'; inp.min = '0'; inp.max = '1000000'; inp.step = '1'; inp.inputMode = 'numeric';
      inp.id = 'rst-c' + star; lab.htmlFor = inp.id;
      var track = el('div', 'rst-track'); track.setAttribute('aria-hidden', 'true');
      var fill = el('i', 'rst-fill'); var add = el('i', 'rst-add');
      track.appendChild(fill); track.appendChild(add);
      var pct = el('span', 'rst-pct', '0%');
      inp.addEventListener('input', function () {
        var v = parseInt(inp.value, 10);
        state.counts[i] = isNaN(v) ? 0 : Math.min(1000000, Math.max(0, v));
        render();
      });
      row.appendChild(lab); row.appendChild(track); row.appendChild(pct); row.appendChild(inp);
      rowsWrap.appendChild(row);
      rows[i] = { inp: inp, fill: fill, add: add, pct: pct };
    })(s);
  }
  ledger.appendChild(rowsWrap);
  var total = el('p', 'rst-total'); ledger.appendChild(total);

  var gauge = el('section', 'rst-gauge');
  gauge.innerHTML = '<p class="rst-step">Step 2</p><h2>Stress the rating</h2>';
  var ruler = el('div', 'rst-ruler'); gauge.appendChild(ruler);
  var legendEl = el('div', 'rst-keys', '<span><i class="k-head"></i>Headline average</span><span><i class="k-adj"></i>Adjusted for sample size</span><span class="rst-k-str" hidden><i class="k-str"></i>After extra 1-star reviews</span>');
  gauge.appendChild(legendEl);
  var stressBox = el('div', 'rst-stress');
  stressBox.innerHTML = '<label for="rst-slider">Add <b id="rst-sn">0</b> one-star reviews</label>';
  var slider = el('input'); slider.type = 'range'; slider.min = '0'; slider.max = '40'; slider.step = '1'; slider.value = '0'; slider.id = 'rst-slider';
  stressBox.appendChild(slider);
  var sres = el('p', 'rst-sres'); stressBox.appendChild(sres);
  gauge.appendChild(stressBox);
  var tiles = el('div', 'rst-tiles'); gauge.appendChild(tiles);
  var verdict = el('p', 'rst-verdict'); gauge.appendChild(verdict);
  slider.addEventListener('input', function () { state.stress = parseInt(slider.value, 10) || 0; render(); });

  var desk = el('section', 'rst-desk');
  desk.innerHTML = '<p class="rst-step">Step 3</p><h2>Ask an AI analyst to read it</h2><p class="rst-lead">Pick a voice. It explains this exact distribution in plain English. All three are AI writing styles, not people.</p>';
  var voices = el('div', 'rst-voices'); voices.setAttribute('role', 'radiogroup'); voices.setAttribute('aria-label', 'AI analyst voice');
  cfg.voices.forEach(function (v, i) {
    var b = el('button', 'rst-voice'); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.slug = v.slug;
    b.setAttribute('aria-checked', i === 0 ? 'true' : 'false');
    b.innerHTML = '<span class="rst-mono" aria-hidden="true">' + esc(v.name.charAt(0)) + '</span><span><em>AI voice</em><b>' + esc(v.name) + ', ' + esc(v.role) + '</b><small>' + esc(v.blurb) + '</small></span>';
    b.addEventListener('click', function () {
      state.voice = v.slug;
      [].forEach.call(voices.children, function (c) { c.setAttribute('aria-checked', c === b ? 'true' : 'false'); });
    });
    voices.appendChild(b);
  });
  desk.appendChild(voices);
  var ctx = el('input', 'rst-ctx'); ctx.type = 'text'; ctx.maxLength = 200; ctx.id = 'rst-ctx';
  ctx.placeholder = 'Optional: what is this rating for? e.g. a phone-reading platform';
  ctx.setAttribute('aria-label', 'What is this rating for (optional)');
  desk.appendChild(ctx);
  var chips = el('div', 'rst-presets');
  (cfg.samples || []).forEach(function (t) {
    var c = el('button', 'rst-chip', esc(t)); c.type = 'button';
    c.addEventListener('click', function () { ctx.value = t; ctx.focus(); });
    chips.appendChild(c);
  });
  desk.appendChild(chips);
  var go = el('button', 'btn btn--gold btn--lg rst-go', 'Ask the analyst'); go.type = 'button';
  go.setAttribute('data-nebula-preserve', '1');
  desk.appendChild(go);
  desk.appendChild(el('p', 'rst-note', 'AI-written explanation for general education. It does not rate or rank any real service, and it cannot verify that a set of reviews is genuine. Please leave out names and private details.'));
  var out = el('div'); desk.appendChild(out);

  root.appendChild(ledger); root.appendChild(gauge); root.appendChild(desk);

  /* ---------- відмальовування ---------- */
  function syncInputs() { rows.forEach(function (r, i) { r.inp.value = state.counts[i]; }); }
  function xOf(v) { return 24 + (Math.max(1, Math.min(5, v)) - 1) / 4 * 352; }

  function render() {
    var m = metrics(state.counts);
    var c = state.counts;
    var maxStress = m ? Math.max(20, Math.min(500, Math.round(m.n * 0.3))) : 20;
    slider.max = String(maxStress);
    if (state.stress > maxStress) state.stress = maxStress;
    slider.value = String(state.stress);
    document.getElementById('rst-sn').textContent = state.stress;
    var shown = c.slice(); shown[0] += state.stress;
    var ms = metrics(shown);
    var maxc = Math.max.apply(null, shown.concat([1]));
    rows.forEach(function (r, i) {
      r.fill.style.width = (c[i] / maxc * 100) + '%';
      r.add.style.width = (i === 0 ? state.stress / maxc * 100 : 0) + '%';
      r.pct.textContent = m ? Math.round(c[i] / m.n * 100) + '%' : '0%';
    });
    go.disabled = !m || state.busy;
    if (!m) {
      total.textContent = 'Enter at least one review to see the numbers.';
      ruler.innerHTML = ''; tiles.innerHTML = ''; verdict.textContent = ''; sres.textContent = '';
      legendEl.querySelector('.rst-k-str').hidden = true;
      return;
    }
    total.innerHTML = '<b>' + fmt(m.n) + '</b> reviews in total';
    var h = xOf(m.mean), a = xOf(m.adjusted), t = xOf(ms.mean);
    var svg = '<svg viewBox="0 0 400 100" role="img" aria-label="Headline average ' + m.mean.toFixed(2) + ', adjusted score ' + m.adjusted.toFixed(2) + (state.stress ? ', after extra one-star reviews ' + ms.mean.toFixed(2) : '') + '">';
    svg += '<line class="ax" x1="24" y1="56" x2="376" y2="56"/>';
    for (var v = 1; v <= 5; v++) svg += '<line class="tk" x1="' + xOf(v) + '" y1="50" x2="' + xOf(v) + '" y2="62"/><text class="tn" x="' + xOf(v) + '" y="78" text-anchor="middle">' + v + '</text>';
    svg += '<line class="gap" x1="' + h + '" y1="56" x2="' + a + '" y2="56"/>';
    if (state.stress) svg += '<line class="gap2" x1="' + h + '" y1="56" x2="' + t + '" y2="56"/><circle class="mk-str" cx="' + t + '" cy="56" r="8"/><text class="lb-str" x="' + t + '" y="36" text-anchor="middle">' + ms.mean.toFixed(2) + '</text>';
    svg += '<circle class="mk-head" cx="' + h + '" cy="56" r="9"/><text class="lb-head" x="' + h + '" y="' + (state.stress ? 16 : 32) + '" text-anchor="middle">' + m.mean.toFixed(2) + '</text>';
    svg += '<path class="mk-adj" d="M' + a + ' 46 L' + (a + 8) + ' 56 L' + a + ' 66 L' + (a - 8) + ' 56 Z"/><text class="lb-adj" x="' + a + '" y="97" text-anchor="middle">' + m.adjusted.toFixed(2) + '</text>';
    svg += '</svg>';
    ruler.innerHTML = svg;
    legendEl.querySelector('.rst-k-str').hidden = !state.stress;
    sres.innerHTML = state.stress ? 'Headline moves from <b>' + m.mean.toFixed(2) + '</b> to <b>' + ms.mean.toFixed(2) + '</b> (' + (ms.mean - m.mean).toFixed(2) + ').' : 'Drag to see how easily new low scores would move this rating.';
    var frag = fragility(m), sh = shape(m);
    tiles.innerHTML =
      '<div><small>Headline average</small><b>' + m.mean.toFixed(2) + '</b></div>' +
      '<div><small>Adjusted score</small><b>' + m.adjusted.toFixed(2) + '</b></div>' +
      '<div><small>Positive share (4-5 stars)</small><b>' + Math.round(m.p * 100) + '%</b><span>cautious low estimate ' + Math.round(m.wilson * 100) + '%</span></div>' +
      '<div><small>Fragility</small><b>' + (frag === null ? 'n/a' : fmt(frag)) + '</b><span>' + (frag === null ? 'already under 4.0' : 'one-star reviews to fall below 4.0') + '</span></div>';
    verdict.innerHTML = '<span class="rst-pill rst-' + sh.key + '">' + esc(sh.label) + '</span> ' + esc(PIN[sh.key]);
  }
  syncInputs(); render();

  /* ---------- AI-пояснення (потік із автоповтором при обриві) ---------- */
  function md(text) {
    return text.split(/\n{2,}/).map(function (p) {
      return '<p>' + esc(p.trim()).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }
  var panel = null, body = null, status = null;
  function ensurePanel() {
    out.innerHTML = '';
    var v = cfg.voices.filter(function (x) { return x.slug === state.voice; })[0];
    panel = el('div', 'rst-read');
    panel.appendChild(el('div', 'rst-by', 'AI analysis in the voice of ' + esc(v.name) + ' · not a real person'));
    body = el('div'); status = el('div', 'rst-status', 'Reading the numbers…');
    panel.appendChild(body); panel.appendChild(status);
    out.appendChild(panel);
  }
  function stream(attempt) {
    var payload = { voice: state.voice, counts: state.counts.slice(), stress: state.stress, context: ctx.value.trim() };
    var text = '', gotDone = false, cut = false, fatal = null;
    status.className = 'rst-status';
    status.textContent = attempt ? 'The line dropped, trying once more…' : 'Reading the numbers…';
    return fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (res) {
      if (!res.ok) {
        if (res.status === 429) fatal = 'Please wait a minute before asking again.';
        else if (res.status === 400 || res.status === 413) fatal = 'Please check the star counts and try again.';
        return null;
      }
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          var i;
          while ((i = buf.indexOf('\n')) >= 0) {
            var line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (line.indexOf('data:') !== 0) continue;
            var p = line.slice(5).trim();
            if (p === '[DONE]') { gotDone = true; continue; }
            try {
              var j = JSON.parse(p);
              if (j.cut) cut = true;
              if (j.t) { text += j.t; body.innerHTML = md(text); status.textContent = ''; }
            } catch (e) { /* неповний рядок */ }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function () { if (text) cut = true; }).then(function () {
      if (fatal) { status.className = 'rst-status err'; status.textContent = fatal; return finish(true); }
      var ok = gotDone && !cut && text.trim().length > 40;
      if (ok) { status.textContent = ''; return finish(false); }
      if (attempt < 2) { body.innerHTML = ''; return stream(attempt + 1); }
      status.className = 'rst-status err';
      status.textContent = text.trim().length > 40 ? 'The analysis was cut short. You can ask again.' : 'The analysis is unavailable right now. Please try again in a moment.';
      finish(true);
    });
  }
  function finish(failed) {
    state.busy = false; go.textContent = 'Ask again'; render();
    if (!failed) {
      var links = el('div', 'rst-links', '<a href="' + esc(cfg.links.reviews) + '">See our platform reviews &rarr;</a><a href="' + esc(cfg.links.blog) + '">Read the rating guides &rarr;</a>');
      var cp = el('button', 'rst-chip', 'Copy analysis'); cp.type = 'button';
      cp.addEventListener('click', function () {
        (navigator.clipboard ? navigator.clipboard.writeText(body.innerText) : Promise.reject()).then(function () { cp.textContent = 'Copied'; }, function () { cp.textContent = 'Copy not available'; });
      });
      links.appendChild(cp); panel.appendChild(links);
    }
  }
  go.addEventListener('click', function () {
    if (state.busy || !metrics(state.counts)) return;
    state.busy = true; go.disabled = true;
    ensurePanel();
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    stream(0);
  });
})();

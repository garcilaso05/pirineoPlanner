export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}

/** Icono SVG del sprite definido en index.html (<symbol id="i-nombre">). */
export function icon(name, cls = 'i') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', `#i-${name}`);
  s.append(u);
  return s;
}

let tt;
export function toast(msg, ms = 3800) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), ms);
}
export function setHint(text) {
  const h = $('#hint');
  h.textContent = text || ''; h.hidden = !text;
}

const scripts = new Map();
/** Carga un script externo bajo demanda (p. ej. JSZip) una sola vez. */
export function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((res, rej) => {
      const s = el('script', { src });
      s.onload = res; s.onerror = () => { scripts.delete(src); rej(new Error('No se pudo cargar ' + src)); };
      document.head.append(s);
    }));
  }
  return scripts.get(src);
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/* ---------- Diálogos ---------- */
// Diálogo modal con campos; devuelve un objeto con los valores o null si se cancela.
export function askForm(title, fields, { submitLabel = 'Guardar', intro = '' } = {}) {
  return new Promise((res) => {
    const dlg = $('#dlg'), form = $('#dlg-form');
    form.replaceChildren(
      el('h3', {}, title),
      intro ? el('p', { class: 'dlg-intro' }, intro) : null,
      ...fields.map((f) => {
        const attrs = { name: f.name, ...(f.required ? { required: '' } : {}) };
        const control = f.type === 'textarea' ? el('textarea', { ...attrs, rows: f.rows || 4 }, f.value ?? '')
          : f.type === 'select' ? el('select', { ...attrs, ...(f.multiple ? { multiple: '' } : {}) }, (f.options || []).map((o) => {
            const [val, lab] = Array.isArray(o) ? o : [o, o];
            return el('option', { value: val, ...((f.multiple ? f.value?.includes?.(val) : f.value === val) ? { selected: '' } : {}) }, lab);
          }))
            : el('input', { ...attrs, type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', ...(f.type === 'number' ? { step: 'any', inputmode: 'decimal' } : {}) });
        return el('label', {}, f.label, control);
      }),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'ghost', onclick: () => dlg.close('cancel') }, 'Cancelar'),
        el('button', { class: 'primary', value: 'ok' }, submitLabel)));
    dlg.returnValue = '';
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return res(null);
      const data = Object.fromEntries(new FormData(form));
      fields.filter((f) => f.multiple).forEach((f) => { data[f.name] = [...form.querySelector(`[name="${f.name}"]`).selectedOptions].map((o) => o.value); });
      res(data);
    };
    dlg.showModal();
    if (!matchMedia('(pointer: coarse)').matches) form.querySelector('input')?.select(); // en táctil no abrir el teclado solo
  });
}
/** Confirmación con el mismo estilo que el resto de la app (sustituye a confirm()). */
export function confirmDialog(title, text, okLabel = 'Aceptar', danger = false) {
  return new Promise((res) => {
    const dlg = $('#dlg'), form = $('#dlg-form');
    form.replaceChildren(
      el('h3', {}, title), el('p', { class: 'dlg-intro' }, text),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'ghost', onclick: () => dlg.close('cancel') }, 'Cancelar'),
        el('button', { class: danger ? 'danger-solid' : 'primary', value: 'ok' }, okLabel)));
    dlg.returnValue = '';
    dlg.onclose = () => res(dlg.returnValue === 'ok');
    dlg.showModal();
  });
}

/* ---------- Menús desplegables ---------- */
let openMenu = null;
export function closeMenus() {
  if (!openMenu) return false;
  openMenu.menu.hidden = true; openMenu.btn.setAttribute('aria-expanded', 'false'); openMenu = null;
  return true;
}
export function initMenus() {
  const mobile = matchMedia('(max-width: 760px)');
  $$('[data-menu]').forEach((btn) => {
    const menu = $('#' + btn.dataset.menu);
    btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openMenu?.btn === btn) return closeMenus();
      closeMenus();
      menu.hidden = false; openMenu = { btn, menu }; btn.setAttribute('aria-expanded', 'true');
      menu.style.left = menu.style.top = '';
      if (!mobile.matches) { // en escritorio se ancla bajo el botón; en móvil es una hoja inferior (CSS)
        const r = btn.getBoundingClientRect();
        menu.style.top = `${Math.round(r.bottom + 8)}px`;
        menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)))}px`;
      }
    });
    menu.addEventListener('click', (e) => { if (e.target.closest('button')) setTimeout(closeMenus, 0); });
  });
  document.addEventListener('click', (e) => { if (openMenu && !openMenu.menu.contains(e.target)) closeMenus(); });
}

export const $ = (s, r = document) => r.querySelector(s);
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
let tt;
export function toast(msg, ms = 3800) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), ms);
}
// Diálogo modal con campos; devuelve un objeto con los valores o null si se cancela.
export function askForm(title, fields) {
  return new Promise((res) => {
    const dlg = $('#dlg'), form = $('#dlg-form');
    form.replaceChildren(
      el('h3', {}, title),
      ...fields.map((f) => el('label', {}, f.label,
        el('input', { name: f.name, type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', ...(f.required ? { required: '' } : {}), ...(f.type === 'number' ? { step: 'any' } : {}) }))),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'ghost', onclick: () => dlg.close('cancel') }, 'Cancelar'),
        el('button', { class: 'primary', value: 'ok' }, 'Guardar')));
    dlg.returnValue = '';
    dlg.onclose = () => res(dlg.returnValue === 'ok' ? Object.fromEntries(new FormData(form)) : null);
    dlg.showModal();
    form.querySelector('input')?.select();
  });
}

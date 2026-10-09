import { decimalValue } from './meter-core.js';
import { escapeHtml, lockScroll, unlockScroll } from './ui.js';

const MAX = 1e10;
const parts = value => {
    const number = decimalValue(value);
    const text = (number ?? 0).toFixed(Math.min(6, Math.max(3, String(value).replace(',', '.').split('.')[1]?.length || 0)));
    const [integer, fraction] = text.split('.');
    return { number, integer: integer.padStart(6, '0'), fraction };
};
let picker = null;

function closePicker() {
    if (!picker) return;
    const { source, modal } = picker;
    modal.remove(); picker = null; unlockScroll();
    source.closest('.meter-dial')?.querySelector('.dial-display')?.focus();
}

function emit(input, value) {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function openPicker(input) {
    if (input.readOnly || input.disabled || input.closest('fieldset:disabled')) return;
    closePicker();
    const p = parts(input.value), digits = [...p.integer, ...p.fraction];
    const modal = document.createElement('div');
    modal.className = 'modal is-open dial-modal';
    modal.innerHTML = `<div class="modal-box dial-picker" role="dialog" aria-modal="true" aria-labelledby="dialPickerTitle">
        <div class="modal-head"><h3 id="dialPickerTitle">Показник лічильника</h3><button type="button" class="sheet-close" data-dial-cancel aria-label="Закрити">✕</button></div>
        <p class="field-hint">Прокрутіть цифри вгору або вниз. Можна також ввести число вручну.</p>
        <div class="dial-wheels">${digits.map((digit, index) => `${index === p.integer.length ? '<span class="dial-decimal">,</span>' : ''}
            <div class="dial-wheel ${index >= p.integer.length ? 'dial-fraction' : ''}" role="spinbutton" tabindex="0" aria-label="${index < p.integer.length ? `Цифра ${index + 1}` : `Дробова цифра ${index - p.integer.length + 1}`}" aria-valuemin="0" aria-valuemax="9" aria-valuenow="${digit}" data-wheel="${index}">
                ${Array.from({ length: 30 }, (_, n) => `<div class="dial-wheel-digit" aria-hidden="true">${n % 10}</div>`).join('')}</div>`).join('')}</div>
        <label class="field dial-manual"><span class="field-label">Ввести вручну</span><input class="field-input" inputmode="decimal" data-dial-manual value="${escapeHtml(input.value)}" placeholder="Наприклад: 1234,567"></label>
        <p class="dial-picker-error" aria-live="polite"></p><button type="button" class="btn-primary" data-dial-apply>Застосувати</button>
    </div>`;
    document.body.append(modal); lockScroll();
    const wheels = [...modal.querySelectorAll('.dial-wheel')], manual = modal.querySelector('[data-dial-manual]');
    picker = { source: input, modal };
    let ready = false, manualMode = false;
    const numberFromWheels = () => {
        wheels.forEach(wheel => {
            const index = Math.max(0, Math.min(29, Math.round(wheel.scrollTop / 44)));
            digits[Number(wheel.dataset.wheel)] = String(index % 10);
            wheel.setAttribute('aria-valuenow', String(index % 10));
        });
        manual.value = `${digits.slice(0, p.integer.length).join('')}.${digits.slice(p.integer.length).join('')}`;
    };
    wheels.forEach((wheel, index) => {
        wheel.scrollTop = (10 + Number(digits[index])) * 44;
        wheel.addEventListener('scroll', () => { if (ready && !manualMode) numberFromWheels(); });
        wheel.addEventListener('pointerdown', () => { manualMode = false; });
        wheel.addEventListener('focus', () => { manualMode = false; });
        wheel.addEventListener('wheel', () => { manualMode = false; }, { passive: true });
        wheel.addEventListener('keydown', event => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const now = Math.round(wheel.scrollTop / 44);
            wheel.scrollTop = event.key === 'Home' ? 10 * 44 : event.key === 'End' ? 19 * 44
                : Math.max(0, Math.min(29, now + (event.key === 'ArrowUp' ? -1 : 1))) * 44;
        });
        wheel.addEventListener('click', event => {
            const digit = event.target.closest('.dial-wheel-digit');
            if (digit) wheel.scrollTo({ top: [...wheel.children].indexOf(digit) * 44, behavior: 'smooth' });
        });
    });
    requestAnimationFrame(() => requestAnimationFrame(() => { ready = true; }));
    manual.addEventListener('input', () => {
        manualMode = true;
        const next = parts(manual.value);
        if (next.number === null || next.number < 0 || next.number > MAX
            || next.integer.length !== p.integer.length || next.fraction.length !== p.fraction.length) return;
        [...next.integer, ...next.fraction].forEach((digit, index) => {
            wheels[index].scrollTop = (10 + Number(digit)) * 44;
            wheels[index].setAttribute('aria-valuenow', digit);
        });
    });
    modal.querySelectorAll('[data-dial-cancel]').forEach(button => button.addEventListener('click', closePicker));
    modal.addEventListener('click', event => { if (event.target === modal) closePicker(); });
    modal.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.stopPropagation(); closePicker(); }
        if (event.key === 'Tab') {
            const focusable = [...modal.querySelectorAll('button, input, [tabindex="0"]')];
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    });
    modal.querySelector('[data-dial-apply]').addEventListener('click', () => {
        const number = decimalValue(manual.value);
        if (number === null || number < 0 || number > MAX) {
            modal.querySelector('.dial-picker-error').textContent = 'Введіть невід’ємний показник до 10 000 000 000'; return;
        }
        emit(input, Math.round(number * 1e6) / 1e6); closePicker();
    });
    modal.querySelector('[data-dial-cancel]').focus();
}

export function syncMeterDial(input) {
    const host = input.closest('.meter-dial');
    if (!host) return;
    const p = parts(input.value), display = host.querySelector('.dial-display');
    display.innerHTML = p.number === null ? '<span class="dial-empty">Вказати показник</span>'
        : [...p.integer].map(digit => `<span class="dial-digit">${digit}</span>`).join('') + '<span class="dial-decimal">,</span>'
        + [...p.fraction].map(digit => `<span class="dial-digit dial-fraction">${digit}</span>`).join('');
    display.setAttribute('aria-label', `${input.dataset.dialLabel}: ${p.number ?? 'не вказано'}. ${input.readOnly ? 'Попередній показник' : 'Відкрити прокрутку цифр'}`);
    host.classList.toggle('is-readonly', input.readOnly);
    host.querySelectorAll('button').forEach(button => { button.disabled = input.readOnly || input.disabled; });
}

export function enhanceMeterInputs(host) {
    host.querySelectorAll('input[data-field="reading"], input[data-field="baseline"]').forEach(input => {
        if (input.closest('.meter-dial')) { syncMeterDial(input); return; }
        const wrapper = document.createElement('div'); wrapper.className = 'meter-dial';
        input.dataset.dialLabel = input.closest('label')?.querySelector('.field-label')?.textContent || 'Показник';
        input.before(wrapper); wrapper.append(input); input.classList.add('dial-source'); input.tabIndex = -1; input.setAttribute('aria-hidden', 'true');
        wrapper.insertAdjacentHTML('beforeend', '<button type="button" class="dial-display" aria-haspopup="dialog"></button><div class="dial-actions"><button type="button" class="dial-step" data-dial-step="-1" aria-label="Зменшити показник на один">−</button><button type="button" class="dial-edit">Ввести / прокрутити</button><button type="button" class="dial-step" data-dial-step="1" aria-label="Збільшити показник на один">+</button></div>');
        input.addEventListener('input', () => syncMeterDial(input));
        wrapper.querySelector('.dial-display').addEventListener('click', event => { event.preventDefault(); openPicker(input); });
        wrapper.querySelector('.dial-edit').addEventListener('click', event => { event.preventDefault(); openPicker(input); });
        wrapper.querySelectorAll('[data-dial-step]').forEach(button => button.addEventListener('click', event => {
            event.preventDefault();
            const value = Math.min(MAX, Math.max(0, (decimalValue(input.value) ?? 0) + Number(button.dataset.dialStep)));
            emit(input, Math.round(value * 1e6) / 1e6);
        }));
        syncMeterDial(input);
    });
}

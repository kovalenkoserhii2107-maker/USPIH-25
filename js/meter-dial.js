import { decimalValue, integerReading } from './meter-core.js';
import { lockScroll, unlockScroll, escapeHtml } from './ui.js';

const MAX = 1e10;
const parts = value => {
    const number = decimalValue(value);
    return { number, integer: String(Math.trunc(number ?? 0)).padStart(6, '0') };
};
let picker = null;

function closePicker() {
    if (!picker) return;
    const { modal, returnFocus } = picker;
    modal.remove(); picker = null; unlockScroll();
    returnFocus?.focus?.();
}

function emit(input, value) {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Аркуш із барабанами цифр у стилі iOS. Одна реалізація і для мешканця,
 * і для правління: value — поточне значення, preview(n) — живий підпис
 * під барабанами (наприклад, скільки спожито), onApply(n) — ціле число.
 */
export function openMeterPicker({ value, title = 'Показник лічильника', subtitle = '', preview = null, onApply, returnFocus = null }) {
    closePicker();
    const p = parts(value), digits = [...p.integer];
    const modal = document.createElement('div');
    modal.className = 'modal is-open dial-modal';
    modal.innerHTML = `<div class="modal-box dial-picker" role="dialog" aria-modal="true" aria-labelledby="dialPickerTitle">
        <div class="dial-grabber" aria-hidden="true"></div>
        <div class="dial-head"><button type="button" class="dial-head-btn" data-dial-cancel>Скасувати</button>
            <h3 id="dialPickerTitle">${escapeHtml(title)}</h3>
            <button type="button" class="dial-head-btn is-done" data-dial-apply>Готово</button></div>
        ${subtitle ? `<p class="dial-sub">${escapeHtml(subtitle)}</p>` : ''}
        <div class="dial-wheels">${digits.map((digit, index) => `
            <div class="dial-wheel" role="spinbutton" tabindex="0" aria-label="Цифра ${index + 1} з ${digits.length}" aria-valuemin="0" aria-valuemax="9" aria-valuenow="${digit}" data-wheel="${index}">
                ${Array.from({ length: 30 }, (_, n) => `<div class="dial-wheel-digit" aria-hidden="true">${n % 10}</div>`).join('')}</div>`).join('')}</div>
        <p class="dial-live" aria-live="polite"></p>
        <label class="field dial-manual"><span class="field-label">Або введіть з клавіатури</span><input class="field-input" inputmode="numeric" pattern="[0-9]*" data-dial-manual value="${Math.trunc(p.number ?? 0)}" placeholder="Наприклад: 1234"></label>
        <p class="dial-picker-error" aria-live="polite"></p>
    </div>`;
    document.body.append(modal); lockScroll();
    const wheels = [...modal.querySelectorAll('.dial-wheel')], manual = modal.querySelector('[data-dial-manual]');
    const live = modal.querySelector('.dial-live'), error = modal.querySelector('.dial-picker-error');
    picker = { modal, returnFocus };
    let ready = false, manualMode = false;
    const showPreview = () => {
        const number = integerReading(manual.value);
        live.textContent = preview && number !== null ? preview(number) : '';
        live.hidden = !live.textContent;
    };
    const numberFromWheels = () => {
        wheels.forEach(wheel => {
            const index = Math.max(0, Math.min(29, Math.round(wheel.scrollTop / 44)));
            digits[Number(wheel.dataset.wheel)] = String(index % 10);
            wheel.setAttribute('aria-valuenow', String(index % 10));
        });
        manual.value = String(Number(digits.join('')));
        error.textContent = ''; showPreview();
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
    showPreview();
    manual.addEventListener('input', () => {
        manualMode = true; error.textContent = ''; showPreview();
        const next = parts(manual.value);
        if (integerReading(manual.value) === null || next.integer.length !== p.integer.length) return;
        [...next.integer].forEach((digit, index) => {
            wheels[index].scrollTop = (10 + Number(digit)) * 44;
            wheels[index].setAttribute('aria-valuenow', digit);
        });
    });
    const apply = () => {
        const number = integerReading(manual.value);
        if (number === null || !/^\d+$/.test(manual.value.trim())) {
            error.textContent = 'Введіть цілий невід’ємний показник без коми чи крапки'; return;
        }
        closePicker(); onApply(number);
    };
    manual.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); apply(); } });
    modal.querySelector('[data-dial-cancel]').addEventListener('click', closePicker);
    modal.querySelector('[data-dial-apply]').addEventListener('click', apply);
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
    wheels[0]?.focus({ preventScroll: true });
}

function openPicker(input) {
    if (input.readOnly || input.disabled || input.closest('fieldset:disabled')) return;
    openMeterPicker({ value: input.value, onApply: number => emit(input, number),
        returnFocus: input.closest('.meter-dial')?.querySelector('.dial-display') });
}

export function syncMeterDial(input) {
    const host = input.closest('.meter-dial');
    if (!host) return;
    const p = parts(input.value), display = host.querySelector('.dial-display');
    display.innerHTML = input.dataset.field === 'baseline'
        ? `<span class="dial-previous-value">${p.number === null ? 'Вказати попередній' : Math.trunc(p.number).toLocaleString('uk-UA')}</span>${input.readOnly ? '' : '<span class="dial-previous-edit">Змінити</span>'}`
        : [...p.integer].map(digit => `<span class="dial-digit">${digit}</span>`).join('');
    host.classList.toggle('is-empty', p.number === null);
    display.setAttribute('aria-label', `${input.dataset.dialLabel}: ${p.number ?? 'не вказано'}. ${input.readOnly ? 'Попередній показник' : 'Відкрити прокрутку цифр'}`);
    host.classList.toggle('is-readonly', input.readOnly);
    host.querySelectorAll('button').forEach(button => { button.disabled = input.readOnly || input.disabled; });
}

export function enhanceMeterInputs(host) {
    host.querySelectorAll('input[data-field="reading"], input[data-field="baseline"]').forEach(input => {
        if (input.closest('.meter-dial')) { syncMeterDial(input); return; }
        const wrapper = document.createElement('div'); wrapper.className = `meter-dial${input.dataset.field === 'baseline' ? ' dial-previous' : ''}`;
        input.dataset.dialLabel = input.closest('label')?.querySelector('.field-label')?.textContent || 'Показник';
        input.before(wrapper); wrapper.append(input); input.classList.add('dial-source'); input.tabIndex = -1; input.setAttribute('aria-hidden', 'true');
        wrapper.insertAdjacentHTML('beforeend', '<button type="button" class="dial-display" aria-haspopup="dialog"></button>' + (input.dataset.field === 'baseline' ? '' : '<div class="dial-actions"><button type="button" class="dial-step" data-dial-step="-1" aria-label="Зменшити показник на один">−</button><button type="button" class="dial-step" data-dial-step="1" aria-label="Збільшити показник на один">+</button></div>'));
        input.addEventListener('input', () => syncMeterDial(input));
        wrapper.querySelector('.dial-display').addEventListener('click', event => { event.preventDefault(); openPicker(input); });
        wrapper.querySelectorAll('[data-dial-step]').forEach(button => button.addEventListener('click', event => {
            event.preventDefault();
            const value = Math.min(MAX, Math.max(0, Math.trunc(decimalValue(input.value) ?? 0) + Number(button.dataset.dialStep)));
            emit(input, value);
        }));
        syncMeterDial(input);
    });
}

import { apartmentMeterStore } from './apartment-meter-store.js';
import { APARTMENT_RESOURCES, apartmentSeries, normalizeApartmentReading, validateApartmentChanges } from './apartment-meter-core.js';
import { METER_RESOURCES, periodLabel } from './meter-core.js';
import { enhanceMeterInputs, syncMeterDial } from './meter-dial.js';
import { escapeHtml, toast, setBusy, formatDateTime } from './ui.js';
import { currentApt } from './firebase.js';
import { loadApartmentHeat } from './meters.js';

const el = id => document.getElementById(id);
const month = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);
const num = value => Number(value).toLocaleString('uk-UA', { maximumFractionDigits: 6 });
let context = null, saving = false, loadRequest = 0, submissionsRequest = 0, submitted = [];
const dirty = new Set(), drafts = new Map();

function read(card) {
    const field = name => card.querySelector(`[data-field="${name}"]`);
    return { resource: card.dataset.apartmentResource, period: el('apartmentMeterPeriod').value,
        reading: field('reading').value, baseline: field('baseline').value, unit: METER_RESOURCES[card.dataset.apartmentResource].units[0],
        reset: field('reset').checked, note: field('note').value };
}

function preview(card) {
    const host = card.querySelector('.meter-preview');
    if (!card.querySelector('[data-field="reading"]').value.trim() || !card.querySelector('[data-field="baseline"]').value.trim()) {
        host.textContent = 'Вкажіть показники. Споживання — різниця вихідного та вхідного.';
        host.classList.remove('is-error'); return;
    }
    try {
        const value = normalizeApartmentReading(read(card));
        const rows = context.records.filter(row => row.resource !== value.resource || row.period !== value.period);
        const current = apartmentSeries([...rows, value], value.resource).find(row => row.period === value.period);
        if (current.error) throw new Error(current.error);
        host.textContent = `Спожито: ${num(current.consumption)} ${current.unit}`; host.classList.remove('is-error');
    } catch (error) { host.textContent = error.message; host.classList.add('is-error'); }
}

function render({ remember = true } = {}) {
    if (!context) return;
    const host = el('apartmentMeterEntry'), period = el('apartmentMeterPeriod').value;
    if (remember && host.dataset.period && dirty.size) {
        const draft = drafts.get(host.dataset.period) || new Map();
        host.querySelectorAll('[data-apartment-resource]').forEach(card => {
            if (dirty.has(card.dataset.apartmentResource)) draft.set(card.dataset.apartmentResource, { ...read(card), period: host.dataset.period });
        }); drafts.set(host.dataset.period, draft);
    }
    dirty.clear(); const draft = drafts.get(period) || new Map(); draft.forEach((_, key) => dirty.add(key)); host.dataset.period = period;
    host.innerHTML = APARTMENT_RESOURCES.map(key => {
        const resource = METER_RESOURCES[key], rows = apartmentSeries(context.records, key);
        const prior = rows.filter(row => row.period < period).at(-1), saved = rows.find(row => row.period === period);
        const current = { ...saved, ...draft.get(key) }, reset = current.reset === true;
        const baseline = reset ? current.baseline ?? 0 : prior?.reading ?? current.baseline ?? '';
        return `<fieldset class="meter-entry-card" data-apartment-resource="${key}"><legend><span class="meter-dot" style="background:${resource.color}"></span>${resource.label} · ${resource.units[0]}</legend>
            <label class="field meter-previous-field"><span class="field-label">Попередній показник ${prior && !reset ? `· ${escapeHtml(periodLabel(prior.period))}` : '· початок обліку'}</span>
                <input class="field-input" data-field="baseline" inputmode="numeric" value="${escapeHtml(baseline)}" ${prior && !reset ? 'readonly' : ''}></label>
            <label class="field meter-new-field"><span class="field-label">Новий показник · ${escapeHtml(periodLabel(period))}</span>
                <input class="field-input" data-field="reading" inputmode="numeric" value="${escapeHtml(current.reading ?? prior?.reading ?? '')}"></label>
            <p class="meter-preview" aria-live="polite"></p>
            <details class="meter-extra"><summary>Заміна лічильника / примітка</summary>
                <label class="meter-reset"><input type="checkbox" data-field="reset" ${reset ? 'checked' : ''}> Лічильник замінено або обнулено</label>
                <label class="field"><span class="field-label">Примітка</span><input class="field-input" data-field="note" maxlength="500" value="${escapeHtml(current.note || '')}" placeholder="За потреби"></label>
            </details></fieldset>`;
    }).join('');
    enhanceMeterInputs(host); host.querySelectorAll('[data-apartment-resource]').forEach(preview);
    const records = APARTMENT_RESOURCES.flatMap(resource => apartmentSeries(context.records, resource)).sort((a, b) => b.period.localeCompare(a.period));
    el('apartmentMeterHistory').innerHTML = records.length ? records.map(row => `<article class="meter-history-row">
        <div class="meter-history-head"><b>${escapeHtml(periodLabel(row.period))} · ${METER_RESOURCES[row.resource].label}</b></div>
        <p>${num(row.effectiveBaseline)} → ${num(row.reading)} ${row.unit} · ${row.error ? escapeHtml(row.error) : `спожито ${num(row.consumption)} ${row.unit}`}</p>
        ${row.note ? `<p>${escapeHtml(row.note)}</p>` : ''}<small>Подано ${escapeHtml(formatDateTime(row.updatedAt))}${row.reset ? ' · новий лічильник' : ''}</small>
        <button type="button" class="btn-soft btn-compact" data-apartment-edit="${row.period}">Редагувати</button></article>`).join('') : '<p class="list-empty">Ваших показників ще немає.</p>';
}

export async function loadApartmentMeters() {
    const request = ++loadRequest, apt = String(currentApt() || '');
    const heatTask = loadApartmentHeat(el('apartmentMeterPeriod').value);
    el('apartmentMeterFields').disabled = true;
    if (context && context.apt !== apt) {
        context = null; drafts.clear(); dirty.clear(); el('apartmentMeterEntry').innerHTML = '';
        delete el('apartmentMeterEntry').dataset.period; el('apartmentMeterHistory').innerHTML = '';
    }
    try {
        const fresh = await apartmentMeterStore.load();
        if (request !== loadRequest || fresh.apt !== String(currentApt() || '')) return;
        if (context && context.apt !== fresh.apt) { drafts.clear(); dirty.clear(); el('apartmentMeterEntry').innerHTML = ''; delete el('apartmentMeterEntry').dataset.period; }
        context = fresh; render();
        el('apartmentMeterApartment').textContent = `Квартира ${context.apt}`;
        el('apartmentMeterFields').disabled = false;
    } catch (error) {
        if (request !== loadRequest) return;
        el('apartmentMeterFields').disabled = true;
        el('apartmentMeterHistory').innerHTML = '<p class="list-empty">Не вдалося прочитати особисті показники. Спробуйте оновити.</p>';
        toast(error.code === 'permission-denied' ? 'Особисті показники поки недоступні. Зверніться до правління' : error.message, 'error');
    } finally { await heatTask; }
}

async function save() {
    if (saving || !context) return;
    const button = el('apartmentMeterSaveBtn');
    try {
        const changes = [...el('apartmentMeterEntry').querySelectorAll('[data-apartment-resource]')].filter(card => dirty.has(card.dataset.apartmentResource)).map(read);
        if (!changes.length) return toast('Змініть вихідний показник, щоб подати його', 'error');
        validateApartmentChanges(context.records, changes);
        saving = true; el('apartmentMeterFields').disabled = true; setBusy(button, true, 'Збереження…');
        context = await apartmentMeterStore.save(context, changes);
        drafts.delete(el('apartmentMeterPeriod').value); dirty.clear(); render({ remember: false }); toast('Ваші показники подано', 'success');
    } catch (error) { toast(error.message, 'error'); }
    finally { saving = false; el('apartmentMeterFields').disabled = false; setBusy(button, false); }
}

function renderSubmissions() {
    const host = el('apartmentSubmissions');
    const term = el('apartmentSubmissionsSearch').value.trim().toLowerCase();
    const filtered = submitted.filter(row => row.apt.toLowerCase().includes(term)).sort((a, b) => a.apt.localeCompare(b.apt, 'uk', { numeric: true }) || a.resource.localeCompare(b.resource));
    host.innerHTML = `<p class="field-hint">Подано записів: ${submitted.length}</p>` + (filtered.length ? filtered.map(row => `<article class="meter-history-row"><div class="meter-history-head"><b>Кв. ${escapeHtml(row.apt)} · ${METER_RESOURCES[row.resource]?.label || escapeHtml(row.resource)}</b></div><p>${num(row.baseline)} → ${num(row.reading)} ${escapeHtml(row.unit)} · спожито ${num(row.reading - row.baseline)} ${escapeHtml(row.unit)}</p><small>${escapeHtml(formatDateTime(row.updatedAt))}</small>${row.note ? `<p>${escapeHtml(row.note)}</p>` : ''}</article>`).join('') : '<p class="list-empty">Поданих показників за цей місяць немає.</p>');
}

export async function loadApartmentSubmissions() {
    const request = ++submissionsRequest, host = el('apartmentSubmissions');
    submitted = [];
    host.innerHTML = '<p class="list-empty">Завантаження…</p>';
    try {
        const rows = await apartmentMeterStore.submissions(el('apartmentSubmissionsPeriod').value);
        if (request !== submissionsRequest) return;
        submitted = rows; renderSubmissions();
    } catch (error) { if (request !== submissionsRequest) return; submitted = []; host.innerHTML = '<p class="list-empty">Не вдалося прочитати показники квартир.</p>'; toast(error.message, 'error'); }
}

export function initApartmentMeters() {
    const period = el('apartmentMeterPeriod');
    if (!period || period.dataset.initialized) return;
    period.dataset.initialized = '1'; period.value = month(); el('apartmentSubmissionsPeriod').value = month();
    period.addEventListener('change', () => { if (!saving) { render(); loadApartmentHeat(period.value); } });
    el('apartmentMeterRefreshBtn').addEventListener('click', () => { if (!saving) loadApartmentMeters(); });
    el('apartmentMeterSaveBtn').addEventListener('click', save);
    el('apartmentMeterEntry').addEventListener('input', event => {
        const card = event.target.closest('[data-apartment-resource]'); if (!card || saving) return;
        dirty.add(card.dataset.apartmentResource);
        if (event.target.dataset.field === 'reset') {
            const prior = apartmentSeries(context.records, card.dataset.apartmentResource).filter(row => row.period < period.value).at(-1);
            const baseline = card.querySelector('[data-field="baseline"]'); baseline.readOnly = !!prior && !event.target.checked;
            const current = context.records.find(row => row.resource === card.dataset.apartmentResource && row.period === period.value);
            baseline.value = event.target.checked ? 0 : prior?.reading ?? current?.baseline ?? '';
            syncMeterDial(baseline);
        } preview(card);
    });
    el('apartmentMeterHistory').addEventListener('click', event => {
        const button = event.target.closest('[data-apartment-edit]');
        if (button && !saving) { period.value = button.dataset.apartmentEdit; render(); loadApartmentHeat(period.value); period.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
    el('apartmentSubmissionsPeriod').addEventListener('change', loadApartmentSubmissions);
    el('apartmentSubmissionsSearch').addEventListener('input', renderSubmissions);
    el('apartmentSubmissionsRefreshBtn').addEventListener('click', loadApartmentSubmissions);
}

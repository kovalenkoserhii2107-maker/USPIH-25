import { apartmentMeterStore } from './apartment-meter-store.js';
import { APARTMENT_RESOURCES, WATER_CHANNELS, apartmentChannels, apartmentChannelName, apartmentChannelSeries,
    apartmentSeries, normalizeApartmentChannel, validateApartmentChanges } from './apartment-meter-core.js';
import { METER_RESOURCES, periodLabel, meterSeries } from './meter-core.js';
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
    return { name: field('name')?.value || apartmentChannelName(card.dataset.apartmentResource, card.dataset.apartmentChannel),
        reading: field('reading').value, baseline: field('baseline').value, reset: field('reset').checked, note: field('note').value };
}

function readGroup(group) {
    const resource = group.dataset.apartmentGroup;
    return { resource, period: el('apartmentMeterPeriod').value, unit: METER_RESOURCES[resource].units[0],
        channels: Object.fromEntries([...group.querySelectorAll('[data-apartment-channel]')].map(card => [card.dataset.apartmentChannel, read(card)])) };
}

function preview(card) {
    const host = card.querySelector('.meter-preview');
    if (!card.querySelector('[data-field="reading"]').value.trim() || !card.querySelector('[data-field="baseline"]').value.trim()) {
        host.textContent = 'Вкажіть показники. Споживання — різниця нового та попереднього.';
        host.classList.remove('is-error'); return;
    }
    try {
        const resource = card.dataset.apartmentResource, channel = card.dataset.apartmentChannel, period = el('apartmentMeterPeriod').value;
        const value = normalizeApartmentChannel({ ...read(card), resource, channel, period, unit: METER_RESOURCES[resource].units[0] });
        const rows = apartmentChannelSeries(context.records, resource, channel).filter(row => row.period !== period);
        const current = meterSeries([...rows, { ...value, resource, period, tariff: 0, unit: METER_RESOURCES[resource].units[0] }], resource)
            .find(row => row.period === period);
        if (current.error) throw new Error(current.error);
        host.textContent = `Спожито: ${num(current.consumption)} ${current.unit}`; host.classList.remove('is-error');
    } catch (error) { host.textContent = error.message; host.classList.add('is-error'); }
}

function rememberGroup(group) {
    const period = el('apartmentMeterEntry').dataset.period || el('apartmentMeterPeriod').value;
    const draft = drafts.get(period) || new Map();
    draft.set(group.dataset.apartmentGroup, { ...readGroup(group), period }); drafts.set(period, draft);
}

function rememberEntries() {
    if (!el('apartmentMeterEntry').dataset.period) return;
    el('apartmentMeterEntry').querySelectorAll('[data-apartment-group]').forEach(group => {
        if (dirty.has(group.dataset.apartmentGroup)) rememberGroup(group);
    });
}

function render({ remember = true } = {}) {
    if (!context) return;
    const host = el('apartmentMeterEntry'), period = el('apartmentMeterPeriod').value;
    if (remember) rememberEntries();
    dirty.clear(); const draft = drafts.get(period) || new Map(); draft.forEach((_, key) => dirty.add(key)); host.dataset.period = period;
    host.innerHTML = APARTMENT_RESOURCES.map(key => {
        const resource = METER_RESOURCES[key], rows = context.records.filter(row => row.resource === key).sort((a, b) => a.period.localeCompare(b.period));
        const prior = rows.filter(row => row.period < period).at(-1), saved = rows.find(row => row.period === period);
        const current = draft.get(key) || saved, currentChannels = current ? apartmentChannels(current) : {};
        const layout = current ? currentChannels : prior ? apartmentChannels(prior) : { main: { name: apartmentChannelName(key, 'main') } };
        const dual = key === 'electricity' && 'day' in layout;
        return `<section class="apartment-meter-group" data-apartment-group="${key}">
            <h3><span class="meter-dot" style="background:${resource.color}"></span>${resource.label}</h3>
            ${key === 'electricity' ? `<label class="field"><span class="field-label">Тип електролічильника</span><select class="field-input field-select" data-electricity-mode>
                <option value="single" ${dual ? '' : 'selected'}>Однозонний</option><option value="dual" ${dual ? 'selected' : ''}>Двозонний · день / ніч</option></select></label>` : ''}
            <div class="apartment-channel-list">${Object.entries(layout).map(([channel, settings]) => {
                const history = apartmentChannelSeries(context.records, key, channel), previous = history.filter(row => row.period < period).at(-1);
                const value = currentChannels[channel] || {}, reset = value.reset === true;
                const baseline = reset ? value.baseline ?? 0 : previous?.reading ?? value.baseline ?? '';
                const name = value.name ?? settings.name ?? apartmentChannelName(key, channel);
                return `<fieldset class="meter-entry-card" data-apartment-resource="${key}" data-apartment-channel="${channel}">
                    <legend>${key === 'water' ? `Водомір · ${WATER_CHANNELS.indexOf(channel) + 1}` : apartmentChannelName(key, channel)} · ${resource.units[0]}</legend>
                    ${key === 'water' ? `<div class="apartment-water-head"><label class="field"><span class="field-label">Назва лічильника</span>
                        <input class="field-input" data-field="name" maxlength="60" value="${escapeHtml(name)}" placeholder="Наприклад: ванна, кухня"></label>
                        ${Object.keys(layout).length > 1 ? `<button type="button" class="btn-soft btn-compact" data-water-remove="${channel}" aria-label="Прибрати лічильник ${escapeHtml(name)}">Прибрати</button>` : ''}</div>` : ''}
                    <label class="field meter-previous-field"><span class="field-label">Попередній показник ${previous && !reset ? `· ${escapeHtml(periodLabel(previous.period))}` : '· початок обліку'}</span>
                        <input class="field-input" data-field="baseline" inputmode="numeric" value="${escapeHtml(baseline)}" ${previous && !reset ? 'readonly' : ''}></label>
                    <label class="field meter-new-field"><span class="field-label">Новий показник · ${escapeHtml(periodLabel(period))}</span>
                        <input class="field-input" data-field="reading" inputmode="numeric" value="${escapeHtml(value.reading ?? previous?.reading ?? '')}"></label>
                    <p class="meter-preview" aria-live="polite"></p>
                    <details class="meter-extra"><summary>Заміна лічильника / примітка</summary>
                        <label class="meter-reset"><input type="checkbox" data-field="reset" ${reset ? 'checked' : ''}> Лічильник замінено або обнулено</label>
                        <label class="field"><span class="field-label">Примітка</span><input class="field-input" data-field="note" maxlength="500" value="${escapeHtml(value.note || '')}" placeholder="За потреби"></label>
                    </details></fieldset>`;
            }).join('')}</div>
            ${key === 'water' ? `<button type="button" class="btn-soft" data-water-add ${Object.keys(layout).length >= WATER_CHANNELS.length ? 'disabled' : ''}>+ Додати водомір</button>`
                : dual ? '<p class="field-hint">День і ніч обліковуються окремо. Для першого запису кожної зони вкажіть її попередній показник.</p>' : ''}
        </section>`;
    }).join('');
    enhanceMeterInputs(host); host.querySelectorAll('[data-apartment-channel]').forEach(preview);
    const records = APARTMENT_RESOURCES.flatMap(resource => apartmentSeries(context.records, resource)).sort((a, b) => b.period.localeCompare(a.period));
    el('apartmentMeterHistory').innerHTML = records.length ? records.map(row => `<article class="meter-history-row">
        <div class="meter-history-head"><b>${escapeHtml(periodLabel(row.period))} · ${METER_RESOURCES[row.resource].label}</b></div>
        ${channelHistory(row)}<small>Подано ${escapeHtml(formatDateTime(row.updatedAt))}</small>
        <button type="button" class="btn-soft btn-compact" data-apartment-edit="${row.period}">Редагувати</button></article>`).join('') : '<p class="list-empty">Ваших показників ще немає.</p>';
}

function channelHistory(row) {
    return row.channelReadings.map(value => `<p><b>${escapeHtml(value.name || apartmentChannelName(row.resource, value.channel))}:</b>
        ${num(value.effectiveBaseline)} → ${num(value.reading)} ${escapeHtml(row.unit)} · ${value.error ? escapeHtml(value.error) : `спожито ${num(value.consumption)} ${escapeHtml(row.unit)}`}${value.reset ? ' · новий лічильник' : ''}</p>
        ${value.note ? `<p>${escapeHtml(value.note)}</p>` : ''}`).join('')
        + (row.channelReadings.length > 1 ? `<p><b>Разом спожито: ${num(row.consumption)} ${escapeHtml(row.unit)}</b></p>` : '');
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
        const changes = [...el('apartmentMeterEntry').querySelectorAll('[data-apartment-group]')].filter(group => dirty.has(group.dataset.apartmentGroup)).map(readGroup);
        if (!changes.length) return toast('Змініть новий показник, щоб подати його', 'error');
        validateApartmentChanges(context.records, changes);
        saving = true; el('apartmentMeterFields').disabled = true; setBusy(button, true, 'Збереження…');
        context = await apartmentMeterStore.save(context, changes);
        drafts.delete(el('apartmentMeterPeriod').value); dirty.clear(); render({ remember: false }); toast('Ваші показники подано', 'success');
    } catch (error) { toast(error.code === 'permission-denied' ? 'Правлінню потрібно опублікувати оновлений файл firestore.rules для нових лічильників' : error.message, 'error'); }
    finally { saving = false; el('apartmentMeterFields').disabled = false; setBusy(button, false); }
}

function renderSubmissions() {
    const host = el('apartmentSubmissions'), term = el('apartmentSubmissionsSearch').value.trim().toLowerCase();
    const filtered = submitted.filter(row => row.apt.toLowerCase().includes(term)).sort((a, b) => a.apt.localeCompare(b.apt, 'uk', { numeric: true }) || a.resource.localeCompare(b.resource));
    host.innerHTML = `<p class="field-hint">Подано записів: ${submitted.length}</p>` + (filtered.length ? filtered.map(row => {
        const summary = apartmentSeries([row], row.resource)[0];
        return `<article class="meter-history-row"><div class="meter-history-head"><b>Кв. ${escapeHtml(row.apt)} · ${METER_RESOURCES[row.resource]?.label || escapeHtml(row.resource)}</b></div>
            ${channelHistory(summary)}<small>${escapeHtml(formatDateTime(row.updatedAt))}</small></article>`;
    }).join('') : '<p class="list-empty">Поданих показників за цей місяць немає.</p>');
}

export async function loadApartmentSubmissions() {
    const request = ++submissionsRequest, host = el('apartmentSubmissions');
    submitted = []; host.innerHTML = '<p class="list-empty">Завантаження…</p>';
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
        const card = event.target.closest('[data-apartment-channel]'); if (!card || saving) return;
        dirty.add(card.dataset.apartmentResource);
        if (event.target.dataset.field === 'reset') {
            const prior = apartmentChannelSeries(context.records, card.dataset.apartmentResource, card.dataset.apartmentChannel).filter(row => row.period < period.value).at(-1);
            const baseline = card.querySelector('[data-field="baseline"]'); baseline.readOnly = !!prior && !event.target.checked;
            const current = context.records.find(row => row.resource === card.dataset.apartmentResource && row.period === period.value);
            baseline.value = event.target.checked ? 0 : prior?.reading ?? (current ? apartmentChannels(current)[card.dataset.apartmentChannel]?.baseline : '') ?? '';
            syncMeterDial(baseline);
        } preview(card);
    });
    el('apartmentMeterEntry').addEventListener('change', event => {
        if (!event.target.matches('[data-electricity-mode]') || saving || !context) return;
        rememberEntries();
        const group = event.target.closest('[data-apartment-group]'); rememberGroup(group);
        const draft = drafts.get(period.value), current = draft.get('electricity');
        const saved = context.records.find(row => row.resource === 'electricity' && row.period === period.value);
        const keys = event.target.value === 'dual' ? ['day', 'night'] : ['main'];
        current.channels = Object.fromEntries(keys.map(key => [key, current.channels[key] || (saved ? apartmentChannels(saved)[key] : null)
            || { name: apartmentChannelName('electricity', key), reading: '', baseline: '', reset: false, note: '' }]));
        render({ remember: false });
    });
    el('apartmentMeterEntry').addEventListener('click', event => {
        const button = event.target.closest('[data-water-add], [data-water-remove]'); if (!button || saving || !context) return;
        rememberEntries();
        const group = button.closest('[data-apartment-group]'); rememberGroup(group);
        const current = drafts.get(period.value).get('water');
        if (button.hasAttribute('data-water-add')) {
            const key = WATER_CHANNELS.find(channel => !(channel in current.channels));
            if (key) current.channels[key] = { name: apartmentChannelName('water', key), reading: '', baseline: '', reset: false, note: '' };
        } else if (Object.keys(current.channels).length > 1) delete current.channels[button.dataset.waterRemove];
        render({ remember: false });
    });
    el('apartmentMeterHistory').addEventListener('click', event => {
        const button = event.target.closest('[data-apartment-edit]');
        if (button && !saving) { period.value = button.dataset.apartmentEdit; render(); loadApartmentHeat(period.value); period.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
    el('apartmentSubmissionsPeriod').addEventListener('change', loadApartmentSubmissions);
    el('apartmentSubmissionsSearch').addEventListener('input', renderSubmissions);
    el('apartmentSubmissionsRefreshBtn').addEventListener('click', loadApartmentSubmissions);
}

import { db, currentApt } from './firebase.js';
import { doc, collection, getDocFromServer, getDocsFromServer } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { escapeHtml, toast, setBusy, lockScroll, unlockScroll, formatMoney } from './ui.js';
import { fetchDirectory } from './directory.js';
import { certificateAccount, buildDebtCertificateDoc, buildBoardProtocolDoc } from './admin-document-core.js';
import { formatMeetingDate } from './meeting.js';
import { fetchStaffRole, requireRight } from './staff-core.js';
import { audit } from './audit.js';
import { publishOsbbDocument, populateDocsDropdown } from './requests-admin.js';

let certificateUrl = '', certificateBusy = false, certificateRequest = 0;
let boardFile = null, boardDraftId = null, boardBusy = false;
const el = id => document.getElementById(id);
const today = () => new Date().toLocaleDateString('sv-SE');
const value = id => el(id)?.value.trim() || '';

function renderAccount(apartment) {
    const data = certificateAccount(apartment);
    const balance = data.balance.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    el('certificateAccountPreview').innerHTML = `О/р <b>${escapeHtml(data.account)}</b> · баланс <b>${escapeHtml(balance)} грн</b><br>`
        + (data.debt ? `Заборгованість: ${formatMoney(data.debt)} грн` : 'Заборгованість відсутня');
}

async function requireAdmin() {
    const apt = currentApt();
    if (!apt) throw new Error('Увійдіть у застосунок');
    requireRight(await fetchStaffRole({ doc, getDocFromServer }, db, apt), 'staff', 'Дія доступна лише правлінню');
}

async function apartmentData(apt) {
    if (!apt || apt.includes('/')) throw new Error('Оберіть квартиру');
    await requireAdmin();
    const [snap, owners] = await Promise.all([
        getDocFromServer(doc(db, 'apartments', apt)), getDocsFromServer(collection(db, 'apartments', apt, 'owners'))
    ]);
    if (!snap.exists() || snap.data().isAdmin === true) throw new Error('Квартиру не знайдено в довіднику');
    return { apartment: snap.data(), owners: owners.docs.map(row => row.data()) };
}

async function previewAccount() {
    const request = ++certificateRequest;
    const host = el('certificateAccountPreview');
    const apt = value('certificateApt');
    el('certificateResult').hidden = true;
    if (!apt) { host.textContent = 'Оберіть квартиру, щоб перевірити особовий рахунок і баланс.'; return; }
    host.textContent = 'Читання актуального балансу…';
    try {
        const { apartment } = await apartmentData(apt);
        if (request !== certificateRequest) return;
        renderAccount(apartment);
    } catch (error) { if (request === certificateRequest) host.textContent = error.message; }
}

export async function openCertificateForm(apt = '') {
    el('certificateApt').value = apt;
    el('certificateDate').value = today();
    el('certificateResult').hidden = true;
    el('certificateModal').classList.add('is-open'); lockScroll();
    try {
        const apartments = await fetchDirectory();
        el('certificateApts').innerHTML = apartments.map(row => `<option value="${escapeHtml(row.apt)}">${escapeHtml(
            `${row.personalAccount ? `О/р ${row.personalAccount} · ` : ''}${row.owners.map(owner => owner.name).join('; ')}`)}</option>`).join('');
    } catch (error) { console.warn('Список квартир для довідки:', error); }
    await previewAccount();
}

function closeCertificate() {
    if (certificateBusy) return;
    ++certificateRequest;
    el('certificateModal').classList.remove('is-open'); unlockScroll();
}

async function generateCertificate(btn) {
    if (certificateBusy) return;
    ++certificateRequest;
    certificateBusy = true; setBusy(btn, true, 'Формування…');
    el('certificateFields').disabled = true;
    el('certificateResult').hidden = true;
    try {
        const apt = value('certificateApt');
        const { apartment, owners } = await apartmentData(apt);
        renderAccount(apartment);
        certificateAccount(apartment, value('certificateType'));
        const { loadPdfMake, osbbInfo } = await import('./protocol_pdf.js');
        const [pdfMake, osbb] = await Promise.all([loadPdfMake(), osbbInfo()]);
        const definition = buildDebtCertificateDoc({ apt, apartment, owners, date: today(), number: value('certificateNumber'),
            signer: value('certificateSigner'), position: value('certificatePosition'), purpose: value('certificatePurpose') }, osbb);
        const blob = await new Promise((resolve, reject) => {
            try { pdfMake.createPdf(definition).getBlob(resolve); } catch (error) { reject(error); }
        });
        if (certificateUrl) URL.revokeObjectURL(certificateUrl);
        certificateUrl = URL.createObjectURL(blob);
        const fileName = `Dovidka_${apt.replace(/[^\p{L}\p{N}_-]/gu, '_')}_${today()}.pdf`;
        el('certificateOpenPdf').href = certificateUrl;
        el('certificateDownload').href = certificateUrl; el('certificateDownload').download = fileName;
        el('certificateResult').hidden = false;
        await audit('certificate.debt', { target: `apartments/${apt}`, summary: `Довідка про заборгованість кв. ${apt}` });
        toast('Довідку сформовано', 'success');
    } catch (error) { toast(error.message || 'Не вдалося сформувати довідку', 'error'); }
    finally { certificateBusy = false; el('certificateFields').disabled = false; setBusy(btn, false); }
}

function boardData() {
    return { number: value('boardProtocolNumber'), date: value('boardProtocolDate'), location: value('boardProtocolPlace'),
        chair: value('boardProtocolChair'), secretary: value('boardProtocolSecretary'), present: value('boardProtocolPresent'),
        heard: value('boardProtocolHeard'), decisions: value('boardProtocolDecisions') };
}

async function publishBoard(btn) {
    if (boardBusy) return;
    const data = boardData();
    if (!data.number || !data.date) return toast('Вкажіть номер і дату протоколу', 'error');
    const generated = el('boardProtocolMode').value === 'generate';
    if (!generated && !boardFile) return toast('Оберіть файл протоколу', 'error');
    boardBusy = true; setBusy(btn, true, generated ? 'Формування PDF…' : 'Завантаження…');
    el('boardProtocolFields').disabled = true;
    try {
        await requireAdmin();
        let file = boardFile;
        if (generated) {
            const { loadPdfMake, osbbInfo } = await import('./protocol_pdf.js');
            const [pdfMake, osbb] = await Promise.all([loadPdfMake(), osbbInfo()]);
            const definition = buildBoardProtocolDoc(data, osbb);
            const blob = await new Promise((resolve, reject) => {
                try { pdfMake.createPdf(definition).getBlob(resolve); } catch (error) { reject(error); }
            });
            file = new File([blob], `Protokol_pravlinnia_${data.date}.pdf`, { type: 'application/pdf' });
        }
        boardDraftId ||= doc(collection(db, 'osbb_documents')).id;
        setBusy(btn, true, 'Публікація…');
        await publishOsbbDocument({
            documentId: boardDraftId, title: `Протокол № ${data.number} засідання правління від ${formatMeetingDate(data.date)}`,
            category: 'Протоколи правління', file,
            metadata: { kind: 'boardProtocol', protocolNumber: data.number, protocolDate: data.date,
                ...(generated ? { chairName: data.chair, secretaryName: data.secretary,
                    present: data.present, heard: data.heard, decisions: data.decisions, location: data.location } : {}) }
        });
        boardDraftId = null; boardFile = null;
        el('boardProtocolFile').value = ''; el('boardProtocolFileName').textContent = 'Файл не обрано';
        el('boardProtocolForm').reset(); el('boardProtocolDate').value = today(); toggleBoardMode();
        await audit('protocol.board', { target: 'osbb_documents', summary: `Протокол правління № ${data.number} додано до Бази` });
        toast('Протокол правління додано до Бази', 'success');
        const { loadProtocols } = await import('./meetings.js');
        await Promise.allSettled([loadProtocols(), populateDocsDropdown()]);
    } catch (error) { toast(error.code === 'storage/unauthorized' ? 'Немає дозволу завантажити протокол у сховище' : error.message, 'error'); }
    finally { boardBusy = false; el('boardProtocolFields').disabled = false; setBusy(btn, false); toggleBoardMode(); }
}

function toggleBoardMode() {
    const generated = el('boardProtocolMode').value === 'generate';
    el('boardProtocolUpload').hidden = generated;
    el('boardProtocolText').hidden = !generated;
    for (const id of ['boardProtocolChair', 'boardProtocolSecretary', 'boardProtocolPresent', 'boardProtocolHeard', 'boardProtocolDecisions']) {
        el(id).required = generated;
    }
    el('boardProtocolSaveBtn').textContent = generated ? 'Сформувати й опублікувати PDF' : 'Додати протокол правління';
}

export function initAdminDocuments() {
    const form = el('boardProtocolForm');
    if (!form || form.dataset.initialized) return;
    form.dataset.initialized = '1'; el('boardProtocolDate').value = today();
    el('boardProtocolMode').addEventListener('change', toggleBoardMode);
    el('boardProtocolFile').addEventListener('change', event => {
        boardFile = event.target.files[0] || null;
        el('boardProtocolFileName').textContent = boardFile?.name || 'Файл не обрано';
    });
    form.addEventListener('submit', event => { event.preventDefault(); publishBoard(el('boardProtocolSaveBtn')); });
    el('openCertificateBtn').addEventListener('click', () => openCertificateForm());
    el('closeCertificateBtn').addEventListener('click', closeCertificate);
    el('certificateModal').addEventListener('click', event => { if (event.target === el('certificateModal')) closeCertificate(); });
    el('certificateApt').addEventListener('change', previewAccount);
    el('certificateForm').addEventListener('submit', event => { event.preventDefault(); generateCertificate(el('certificateGenerateBtn')); });
}

// 1. ПІДКЛЮЧЕННЯ FIREBASE
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, collection, getDocs, addDoc, deleteDoc, updateDoc, query, orderBy, serverTimestamp, onSnapshot, where } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, updatePassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyAtNW2KCzP0Xn6vy6h77-ABUJEkcum8rCE",
    authDomain: "uspih-25.firebaseapp.com",
    projectId: "uspih-25",
    storageBucket: "uspih-25.firebasestorage.app",
    messagingSenderId: "56244989310",
    appId: "1:56244989310:web:69c3779936387888d6172f",
    measurementId: "G-FCD4GREECY"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);

const appLoader = document.getElementById('appLoader');
const loginSection = document.getElementById('loginSection');
const passwordSection = document.getElementById('passwordSection');
const dataSection = document.getElementById('dataSection');
const topNav = document.getElementById('topNav');
const ownersContainer = document.getElementById('ownersContainer');
const aptInput = document.getElementById('aptInput');
const passInput = document.getElementById('passInput');

const SESSION_TIMEOUT = 60 * 60 * 1000; 

onAuthStateChanged(auth, async (user) => {
    if (user) {
        const lastActive = localStorage.getItem('session_timestamp');
        if (lastActive && (Date.now() - parseInt(lastActive)) > SESSION_TIMEOUT) {
            await signOut(auth);
            localStorage.removeItem('session_timestamp');
            return; 
        }
        
        localStorage.setItem('session_timestamp', Date.now());
        const apt = user.email.split('@')[0];
        await loadCabinetData(apt);
        startPowerStatusListener();
    } else {
        appLoader.style.display = 'none'; 
        loginSection.style.display = 'block'; 
        dataSection.style.display = 'none';
        topNav.style.display = 'none';
        passwordSection.style.display = 'none';
        stopPowerStatusListener();
    }
});

['click', 'keypress', 'touchstart'].forEach(evt => {
    document.addEventListener(evt, () => {
        if (auth.currentUser) localStorage.setItem('session_timestamp', Date.now());
    });
});

document.getElementById('loginBtn').addEventListener('click', async () => {
    const apt = aptInput.value.trim();
    const pass = passInput.value;
    if (!apt || !pass) return showError("Заповніть усі поля!");

    const btn = document.getElementById('loginBtn');
    btn.innerText = "Перевірка..."; btn.disabled = true;
    document.getElementById('loginError').style.display = "none";

    const email = `${apt}@uspih-25.com`;

    try {
        await signInWithEmailAndPassword(auth, email, pass);
        localStorage.setItem('session_timestamp', Date.now()); 
    } catch (error) {
        if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
            showError("Невірний номер квартири або пароль.");
        } else {
            showError("Помилка: " + error.message);
        }
    } finally {
        btn.innerText = "Увійти"; btn.disabled = false;
    }
});

function showError(msg) {
    const err = document.getElementById('loginError');
    err.innerText = msg; err.style.display = "block";
}

// 3. ЗАВАНТАЖЕННЯ ДАНИХ З FIRESTORE (РОЗПОДІЛЬНИК)
async function loadCabinetData(apt) {
    const aptRef = doc(db, "apartments", apt);
    const aptSnap = await getDoc(aptRef);
    
    let isFirstLogin = true;
    let areaVal = "--";
    let entranceVal = "--"; 
    let isAdmin = false; // Новий прапорець для перевірки ролі

    if (aptSnap.exists()) {
        const data = aptSnap.data();
        isFirstLogin = !data.passwordChanged; 
        areaVal = data.area || "--";
        entranceVal = data.entrance || "--"; 
        isAdmin = data.isAdmin === true; // Перевіряємо, чи це адмінський акаунт (напр. логін 777)
    } else {
        // Якщо квартири немає, створюємо її базовий профіль
        await setDoc(aptRef, { passwordChanged: false, area: "", entrance: "", isAdmin: false, lastLogin: new Date() });
    }

    // МИГТЬОВЕ ПЕРЕМИКАННЯ ЕКРАНІВ (Ховаємо логін і завантаження)
    appLoader.style.display = 'none'; 
    loginSection.style.display = "none";
    topNav.style.display = "none";
    dataSection.style.display = "none";
    document.getElementById('adminDashboardSection').style.display = "none";

    if (isFirstLogin) {
        // Якщо перший вхід — змушуємо змінити пароль (працює і для адміна, і для мешканця)
        document.getElementById('hiddenAptInput').value = apt;
        document.getElementById('cancelPassBtn').style.display = 'none';
        passwordSection.style.display = "block";
        return; // Зупиняємо функцію тут
    }

    // РОЗПОДІЛ МАРШРУТІВ:
    if (isAdmin) {
        // ШЛЯХ А: Це Адміністратор
        document.getElementById('adminDashboardSection').style.display = "block";
        await loadAdminMessageHistory();
        await populateAdminDocsDropdown();
        
        // Тут ми пізніше додамо завантаження статистики або історії надісланих повідомлень
        
    } else {
        // ШЛЯХ Б: Це звичайний мешканець
        topNav.style.display = "block";
        dataSection.style.display = "block";
        
        // Заповнюємо дані картки мешканця
        document.getElementById('displayAptNum').innerText = apt;
        document.getElementById('displayEntranceNum').innerText = entranceVal;
        document.getElementById('displayAreaVal').innerText = areaVal;

        // Контекст у шапці: одразу видно, чий це кабінет
        const navMeta = document.getElementById('navAptMeta');
        if (navMeta) {
            navMeta.innerText = entranceVal && entranceVal !== '--'
                ? `Квартира ${apt} · Парадна ${entranceVal}`
                : `Квартира ${apt}`;
        }

        // Завантажуємо співвласників
        ownersContainer.innerHTML = "";
        const ownersRef = collection(db, "apartments", apt, "owners");
        const ownersSnap = await getDocs(ownersRef);
        
        if (!ownersSnap.empty) {
            let count = 1;
            ownersSnap.forEach(doc => {
                renderOwnerCard(doc.data(), count++, false);
            });
        } else {
            renderOwnerCard(null, 1, true);
        }
        await loadUserMessages(apt, entranceVal);
        // Тут ми пізніше викличемо функцію завантаження вхідних новин для мешканця
    }
}

// 4. ОНОВЛЕННЯ ДАНИХ СВІВВЛАСНИКІВ У БАЗІ (Площа більше не зберігається звідси)
async function saveAllDataToFirebase() {
    const apt = document.getElementById('displayAptNum').innerText;
    if (!apt || apt === "--") throw new Error("Квартира не визначена");

    const ownerCards = document.querySelectorAll('.owner-card');
    const ownersCollectionRef = collection(db, "apartments", apt, "owners");

    const oldOwners = await getDocs(ownersCollectionRef);
    for (let d of oldOwners.docs) {
        await deleteDoc(d.ref);
    }

    for (let card of ownerCards) {
        const name = card.querySelector('.i-name').value;
        if (!name) continue; 
        
        const presetSelect = card.querySelector('.i-share-preset').value;
        const customInput = card.querySelector('.i-share-custom').value;
        const fileInput = card.querySelector('.i-files');
        const existingFilesInput = card.querySelector('.h-existing-files');
        
        let shareFrac = "", sharePerc = "";
        if (presetSelect === 'custom') {
            const calc = calculateShares(customInput);
            shareFrac = calc.frac; sharePerc = calc.perc;
        } else if (presetSelect) {
            const parts = presetSelect.split('|');
            shareFrac = parts[0]; sharePerc = parts[1];
        }

        let allFileUrls = [];
        if (existingFilesInput && existingFilesInput.value) {
            allFileUrls.push(...existingFilesInput.value.split(',').filter(u => u.trim() !== ''));
        }

        if (fileInput && fileInput.files.length > 0) {
            for (let file of fileInput.files) {
                const fileRef = sRef(storage, `apartments/${apt}/${Date.now()}_${file.name}`);
                await uploadBytes(fileRef, file);
                const url = await getDownloadURL(fileRef);
                allFileUrls.push(url);
            }
        }

        await addDoc(ownersCollectionRef, {
            name: name,
            docInfo: card.querySelector('.i-doc').value,
            shareFrac: shareFrac,
            sharePerc: sharePerc,
            fileUrls: allFileUrls.join(',')
        });
    }
}

// 5. ЛОГІКА МЕНЮ ТА ДЗВІНОЧКА
const bellBtn = document.getElementById('bellBtn');
const notifPopup = document.getElementById('notifPopup');
const menuBtn = document.getElementById('menuBtn');
const menuPopup = document.getElementById('menuPopup');

const navBackdrop = document.getElementById('navBackdrop');

function syncNavBackdrop() {
    const anyOpen = notifPopup.style.display === 'block' || menuPopup.style.display === 'block';
    navBackdrop.style.display = anyOpen ? 'block' : 'none';
    document.body.style.overflow = anyOpen ? 'hidden' : '';
}

function closeAllSheets() {
    notifPopup.style.display = 'none';
    closeAllSheets();
    syncNavBackdrop();
}

bellBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = notifPopup.style.display !== 'block';
    closeAllSheets();
    notifPopup.style.display = willOpen ? 'block' : 'none';
    document.getElementById('notifBadge').style.display = 'none';
    syncNavBackdrop();
});
menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menuPopup.style.display !== 'block';
    notifPopup.style.display = 'none';
    menuPopup.style.display = willOpen ? 'block' : 'none';
    syncNavBackdrop();
});

// Закриття: тап по затемненню, по хрестику або клавіша Esc
navBackdrop.addEventListener('click', closeAllSheets);
document.querySelectorAll('[data-close-sheet]').forEach(btn => {
    btn.addEventListener('click', closeAllSheets);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllSheets(); });

document.getElementById('menuLogoutBtn').addEventListener('click', async () => {
    localStorage.removeItem('session_timestamp'); 
    await signOut(auth); 
    location.reload(); 
});

// Кнопка ВИХІД для Адміна
document.getElementById('adminLogoutBtn').addEventListener('click', async () => {
    localStorage.removeItem('session_timestamp'); 
    await signOut(auth); 
    location.reload(); 
});

// Логіка перемикання "Кому надіслати" в панелі адміна
document.getElementById('adminMsgTargetType').addEventListener('change', function() {
    const targetValueGroup = document.getElementById('adminMsgTargetValueGroup');
    if (this.value === 'all') {
        targetValueGroup.style.display = 'none';
    } else {
        targetValueGroup.style.display = 'block';
    }
});

// ==========================================
// ЛОГІКА ПАНЕЛІ ПРАВЛІННЯ (АДМІН)
// ==========================================

// 1. Автоматичне розширення текстового поля
const adminMsgBody = document.getElementById('adminMsgBody');
if (adminMsgBody) {
    adminMsgBody.addEventListener('input', function() {
        this.style.height = 'auto'; // Скидаємо висоту
        this.style.height = (this.scrollHeight) + 'px'; // Встановлюємо нову висоту за контентом
    });
}

// 2. Логіка перемикання "Кому надіслати"
document.getElementById('adminMsgTargetType').addEventListener('change', function() {
    const targetValueGroup = document.getElementById('adminMsgTargetValueGroup');
    if (this.value === 'all') {
        targetValueGroup.style.display = 'none';
        document.getElementById('adminMsgTargetValue').value = ''; // Очищаємо, якщо вибрали "Усім"
    } else {
        targetValueGroup.style.display = 'block';
    }
});

// 3. Відправка повідомлення в базу даних Firebase
document.getElementById('adminSendMsgBtn').addEventListener('click', async () => {
    const title = document.getElementById('adminMsgTitle').value.trim();
    const body = document.getElementById('adminMsgBody').value.trim();
    const targetType = document.getElementById('adminMsgTargetType').value;
    const targetValue = document.getElementById('adminMsgTargetValue').value.trim();
    const fileInput = document.getElementById('adminMsgFiles');
    const linkedDocStr = document.getElementById('adminMsgLinkedDoc').value;
    const linkedDoc = linkedDocStr ? JSON.parse(decodeURIComponent(linkedDocStr)) : null;

    if (!title || !body) {
        alert('Будь ласка, заповніть заголовок та текст повідомлення.');
        return;
    }
    if (targetType !== 'all' && !targetValue) {
        alert('Будь ласка, вкажіть номери квартир або парадних для відправки.');
        return;
    }

    const btn = document.getElementById('adminSendMsgBtn');
    btn.innerText = 'Відправка та завантаження файлів...';
    btn.disabled = true;

    try {
        let fileUrls = [];
        let failedFiles = [];
        
        // Надійно завантажуємо кожен файл у Firebase Storage (окремо, щоб один "зламаний" файл не зривав всю відправку)
        if (fileInput && fileInput.files && fileInput.files.length > 0) {
            for (let i = 0; i < fileInput.files.length; i++) {
                const file = fileInput.files[i];
                try {
                    const fileRef = sRef(storage, `messages/${Date.now()}_${file.name}`);
                    await uploadBytes(fileRef, file);
                    const url = await getDownloadURL(fileRef);
                    fileUrls.push({ name: file.name, url: url, type: file.type || '', size: file.size || 0 });
                } catch (fileError) {
                    console.error(`Помилка завантаження файлу "${file.name}":`, fileError);
                    failedFiles.push(file.name);
                }
            }
        }

        if (failedFiles.length > 0) {
            alert(`Увага! Не вдалося завантажити файл(и): ${failedFiles.join(', ')}.\nПовідомлення буде надіслано без них. Перевірте формат/розмір файлу та інтернет-з'єднання.`);
        }

        // Записуємо в базу разом із масивом вкладень
        await addDoc(collection(db, "messages"), {
            title: title,
            body: body,
            targetType: targetType,
            targetValue: targetValue,
            createdAt: serverTimestamp(),
            author: "Правління ОСББ",
            attachments: fileUrls,   // Масив файлів
            linkedDoc: linkedDoc, // ДОДАНО: Внутрішнє посилання на базу
            readBy: {}
        });

        alert('Повідомлення успішно надіслано!');
        
        // Повне очищення форми (включно з правильним скиданням файлового інпуту)
        document.getElementById('adminMsgTitle').value = '';
        document.getElementById('adminMsgBody').value = '';
        document.getElementById('adminMsgBody').style.height = 'auto';
        document.getElementById('adminMsgTargetValue').value = '';
        document.getElementById('adminMsgTargetType').value = 'all';
        document.getElementById('adminMsgTargetValueGroup').style.display = 'none';
        
        if (fileInput) {
            fileInput.type = 'text';
            fileInput.type = 'file'; // Технічний трюк для повного очищення вибору файлів у браузері
        }

        // Скидаємо нові елементи інтерфейсу: сегментований вибір, превʼю файлів, документ з Бази
        document.querySelectorAll('#adminTargetSegmented .segmented-item')
            .forEach(i => i.classList.toggle('active', i.getAttribute('data-target') === 'all'));
        const msgFilesPreview = document.getElementById('adminMsgFilesPreview');
        if (msgFilesPreview) msgFilesPreview.innerHTML = '';
        const linkedDocSelect = document.getElementById('adminMsgLinkedDoc');
        if (linkedDocSelect) linkedDocSelect.value = '';

        loadAdminMessageHistory(); // Оновлюємо історію
        
    } catch (error) {
        console.error("Помилка відправки:", error);
        alert('Виникла помилка. Перевірте підключення до інтернету.');
    } finally {
        btn.innerText = 'Надіслати повідомлення';
        btn.disabled = false;
    }
});

// 6. МАЛЮВАННЯ КАРТОК СВІВВЛАСНИКІВ
function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function calculateShares(val) {
    val = val.replace(',', '.');
    if (val.includes('/') || val.includes('\\')) {
        let frac = val.replace('\\', '/'); let parts = frac.split('/');
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return { frac: frac, perc: ((parseFloat(parts[0]) / parseFloat(parts[1])) * 100).toFixed(2).replace('.00', '') };
    } else if (!isNaN(parseFloat(val))) {
        let perc = parseFloat(val); let num = Math.round(perc * 100); let den = 10000; let div = gcd(num, den);
        return { frac: `${num/div}/${den/div}`, perc: perc.toString() };
    }
    return { frac: val, perc: val };
}

document.getElementById('addOwnerBtn').addEventListener('click', () => {
    renderOwnerCard(null, ownersContainer.children.length + 1, true, true);
});

function getInitials(fullName) {
    if (!fullName) return '?';
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
}

// Стабільний колір аватара за іменем (щоб співвласники візуально різнилися)
const AVATAR_GRADIENTS = [
    'linear-gradient(135deg, #007AFF, #0056B3)',
    'linear-gradient(135deg, #34C759, #248A3D)',
    'linear-gradient(135deg, #FF9500, #C93400)',
    'linear-gradient(135deg, #AF52DE, #6C2BA0)',
    'linear-gradient(135deg, #FF2D55, #C10E33)',
    'linear-gradient(135deg, #5AC8FA, #0071A4)'
];
function avatarGradient(name) {
    let sum = 0;
    for (let i = 0; i < (name || '').length; i++) sum += name.charCodeAt(i);
    return AVATAR_GRADIENTS[sum % AVATAR_GRADIENTS.length];
}

function renderOwnerCard(ownerData, number, isEditMode, isNewAtTop = false) {
    const card = document.createElement('div');
    card.className = 'owner-card';
    
    let isNew = !ownerData;
    let shareFrac = ownerData ? (ownerData.shareFrac || "") : "";
    let sharePerc = ownerData ? (ownerData.sharePerc || "") : "";
    const name = ownerData ? ownerData.name : "";
    const docInfo = ownerData ? ownerData.docInfo : "";
    const fileUrls = ownerData ? ownerData.fileUrls : "";

    const percNum = parseFloat(sharePerc);
    const hasShare = sharePerc && !isNaN(percNum);
    // Кільцева діаграма частки (SVG), радіус 20 -> довжина кола ≈ 125.66
    const CIRC = 125.66;
    const dash = hasShare ? (CIRC * Math.min(percNum, 100) / 100) : 0;

    const ringHtml = `
        <div class="owner-ring">
            <svg viewBox="0 0 48 48" width="48" height="48">
                <circle cx="24" cy="24" r="20" fill="none" stroke="#E9E9EE" stroke-width="4"></circle>
                <circle cx="24" cy="24" r="20" fill="none" stroke="var(--apple-blue)" stroke-width="4"
                        stroke-linecap="round" stroke-dasharray="${dash} ${CIRC}"
                        transform="rotate(-90 24 24)"></circle>
            </svg>
            <span class="owner-ring-text">${hasShare ? Math.round(percNum) + '%' : '—'}</span>
        </div>`;

    // Вкладені документи власника (використовуємо той самий переглядач, що й для повідомлень)
    let attachHtml = '';
    let ownerFiles = [];
    if (fileUrls && String(fileUrls).trim() !== "") {
        ownerFiles = String(fileUrls).split(",")
            .map(u => u.trim())
            .filter(u => u !== "")
            .map((url, i) => {
                let cleanName = '';
                try {
                    const decoded = decodeURIComponent(url.split('?')[0]);
                    cleanName = decoded.substring(decoded.lastIndexOf('/') + 1).replace(/^\d+_/, '');
                } catch (e) { cleanName = ''; }
                return { name: cleanName || `Документ ${i + 1}`, url: url, type: '', size: 0 };
            });
        attachHtml = `<div class="owner-attachments"></div>`;
    }

    card.innerHTML = `
        <div class="view-mode" style="display: ${isEditMode ? 'none' : 'block'};">
            <div class="owner-head">
                <div class="owner-avatar" style="background: ${avatarGradient(name)};">${getInitials(name)}</div>
                <div class="owner-head-text">
                    <span class="owner-eyebrow">Співвласник ${number}</span>
                    <h3 class="owner-name v-name">${escapeHtml(name) || 'Новий співвласник'}</h3>
                </div>
                <button class="owner-menu-btn edit-btn" aria-label="Редагувати">
                    <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg>
                </button>
            </div>

            <div class="owner-body">
                <div class="owner-share-row">
                    ${ringHtml}
                    <div class="owner-share-text">
                        <span class="owner-field-label">Частка власності</span>
                        <span class="owner-share-value v-share">${shareFrac ? `${shareFrac}` : '—'}</span>
                        <span class="owner-share-sub">${hasShare ? sharePerc + '% від квартири' : 'Не вказано'}</span>
                    </div>
                </div>

                <div class="owner-doc-row">
                    <span class="owner-field-label">Правовстановлюючий документ</span>
                    <span class="owner-doc-value v-doc">${escapeHtml(docInfo) || '—'}</span>
                </div>

                ${attachHtml}
            </div>

            <div class="owner-actions">
                <button class="owner-action-btn edit-btn">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg>
                    Редагувати
                </button>
                <button class="owner-action-btn owner-action-danger delete-btn">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    Видалити
                </button>
            </div>
        </div>

        <div class="edit-mode" style="display: ${isEditMode ? 'block' : 'none'};">
            <input type="hidden" class="h-existing-files" value="${fileUrls}">
            <div class="owner-edit-head">
                <h3 class="owner-edit-title">${name ? 'Редагування даних' : 'Новий співвласник'}</h3>
            </div>

            <div class="field">
                <label class="field-label">ПІБ співвласника</label>
                <input type="text" class="i-name field-input" value="${escapeHtml(name)}" placeholder="Іванов Іван Іванович">
            </div>
            <div class="field">
                <label class="field-label">Частка власності</label>
                <select class="i-share-preset field-input field-select">
                    <option value="">Оберіть зі списку...</option>
                    <option value="1/1|100" ${shareFrac === '1/1' ? 'selected' : ''}>1/1 (100%) — Одноосібна</option>
                    <option value="1/2|50" ${shareFrac === '1/2' ? 'selected' : ''}>1/2 (50%)</option>
                    <option value="1/3|33.33" ${shareFrac === '1/3' ? 'selected' : ''}>1/3 (33.33%)</option>
                    <option value="1/4|25" ${shareFrac === '1/4' ? 'selected' : ''}>1/4 (25%)</option>
                    <option value="2/3|66.67" ${shareFrac === '2/3' ? 'selected' : ''}>2/3 (66.67%)</option>
                    <option value="1/5|20" ${shareFrac === '1/5' ? 'selected' : ''}>1/5 (20%)</option>
                    <option value="custom" ${shareFrac && !['1/1','1/2','1/3','1/4','2/3','1/5'].includes(shareFrac) ? 'selected' : ''}>Інше (ввести вручну)...</option>
                </select>
                <input type="text" class="custom-share-input i-share-custom field-input" style="display: ${shareFrac && !['1/1','1/2','1/3','1/4','2/3','1/5'].includes(shareFrac) ? 'block' : 'none'};" placeholder="Дріб (1/6) або відсоток (15)" value="${shareFrac}">
            </div>
            <div class="field">
                <label class="field-label">Дані документа</label>
                <input type="text" class="i-doc field-input" value="${escapeHtml(docInfo)}" placeholder="Договір купівлі-продажу №123">
            </div>
            <div class="field">
                <span class="field-label">Скан або фото документа</span>
                <label class="dropzone owner-dropzone">
                    <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                    <span class="dropzone-text">Додати файли</span>
                    <input type="file" class="i-files hidden-file-input" multiple accept="image/*,application/pdf">
                </label>
                <div class="file-chips owner-file-chips"></div>
            </div>

            <div class="owner-actions">
                <button class="owner-action-btn owner-action-primary save-ok-btn">Зберегти</button>
                <button class="owner-action-btn cancel-btn">Скасувати</button>
            </div>
        </div>
    `;

    if (isNewAtTop) ownersContainer.prepend(card); else ownersContainer.appendChild(card);

    const presetSelect = card.querySelector('.i-share-preset');
    const customInput = card.querySelector('.i-share-custom');
    presetSelect.addEventListener('change', (e) => {
        if (e.target.value === 'custom') { customInput.style.display = 'block'; customInput.value = ''; } else { customInput.style.display = 'none'; }
    });

    // Кнопок редагування дві (іконка вгорі + кнопка внизу) — вішаємо на обидві
    card.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            card.querySelector('.view-mode').style.display = 'none';
            card.querySelector('.edit-mode').style.display = 'block';
        });
    });
    card.querySelector('.cancel-btn').addEventListener('click', () => {
        if (isNew) card.remove(); else {
            card.querySelector('.edit-mode').style.display = 'none'; card.querySelector('.view-mode').style.display = 'block';
        }
    });

    // Документи власника відкриваються тим самим повноекранним переглядачем
    const attachHolder = card.querySelector('.owner-attachments');
    if (attachHolder && ownerFiles.length > 0) {
        renderAttachments(attachHolder, ownerFiles);
    }

    // Показуємо назви обраних файлів (щоб було видно, що саме прикріплено)
    const ownerFileInput = card.querySelector('.i-files');
    const ownerChips = card.querySelector('.owner-file-chips');
    if (ownerFileInput && ownerChips) {
        ownerFileInput.addEventListener('change', () => renderFileChips(ownerFileInput, ownerChips));
    }
    card.querySelector('.delete-btn').addEventListener('click', async () => {
        if (confirm("Точно видалити цього співвласника?")) {
            card.remove();
            try { await saveAllDataToFirebase(); } catch(e) { alert("Помилка видалення"); }
        }
    });

    card.querySelector('.save-ok-btn').addEventListener('click', async function() {
        const btn = this; btn.innerText = "⏳..."; btn.disabled = true;
        try {
            await saveAllDataToFirebase();
            await loadCabinetData(document.getElementById('displayAptNum').innerText); 
        } catch (error) {
            console.error(error);
            alert("Помилка збереження. Перевірте інтернет.");
        } finally {
            btn.innerText = "Зберегти"; btn.disabled = false;
        }
    });
}

// 7. РОБОТА З ПАРОЛЕМ
document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.addEventListener('click', function() {
        const input = document.getElementById(this.getAttribute('data-target'));
        if (input.type === 'password') {
            input.type = 'text';
            this.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
            this.style.color = 'var(--apple-blue)';
        } else {
            input.type = 'password';
            this.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
            this.style.color = 'var(--text-muted)';
        }
    });
});

document.getElementById('menuChangePassBtn').addEventListener('click', () => {
    closeAllSheets();
    document.getElementById('dataSection').style.display = 'none';
    document.getElementById('hiddenAptInput').value = document.getElementById('displayAptNum').innerText;
    document.getElementById('newPass').value = ''; document.getElementById('confirmPass').value = '';
    document.getElementById('cancelPassBtn').style.display = 'block';
    passwordSection.style.display = 'block';
});

document.getElementById('cancelPassBtn').addEventListener('click', () => {
    passwordSection.style.display = 'none'; dataSection.style.display = 'block';
});

document.getElementById('savePassBtn').addEventListener('click', async () => {
    const newPass = document.getElementById('newPass').value;
    if (newPass !== document.getElementById('confirmPass').value || newPass.length < 6) {
        document.getElementById('passError').innerText = "Паролі не співпадають або коротші 6 символів";
        document.getElementById('passError').style.display = "block"; return;
    }
    const btn = document.getElementById('savePassBtn');
    btn.innerText = "⏳..."; btn.disabled = true;

    try {
        await updatePassword(auth.currentUser, newPass);
        const apt = document.getElementById('hiddenAptInput').value || document.getElementById('displayAptNum').innerText;
        await setDoc(doc(db, "apartments", apt), { passwordChanged: true }, { merge: true });
        
        alert("Пароль успішно змінено!");
        passwordSection.style.display = "none";
        topNav.style.display = "block";
        dataSection.style.display = "block";
    } catch (error) {
        document.getElementById('passError').innerText = "Помилка: " + error.message;
        document.getElementById('passError').style.display = "block";
    } finally {
        btn.innerText = "Зберегти пароль"; btn.disabled = false;
    }
});

// ==========================================
// СИСТЕМА ПОВІДОМЛЕНЬ ТА КОНТРОЛЬ ПРОЧИТАННЯ
// ==========================================
let unreadMsgIds = [];
let currentAptForMessages = "";

// 1. Завантаження новин для конкретного жильця
async function loadUserMessages(apt, entrance) {
    currentAptForMessages = apt;
    const list = document.getElementById('messagesList'); // Знаходимо стрічку у дзвіночку
    const badge = document.getElementById('notifBadge');
    
    if (!list) return; // Якщо HTML ще не оновлений, ігноруємо
    list.innerHTML = '<p style="text-align:center; color:#888;">Завантаження...</p>';
    unreadMsgIds = [];
    
    try {
        const q = query(collection(db, "messages"), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        
        let html = '';
        let count = 0;

        snap.forEach(d => {
            const msg = d.data();
            let isTarget = false;
            
            // Броньована фільтрація: Кому призначена новина? (захист від типів даних та зайвих пробілів)
            const safeApt = String(apt).trim();
            const safeEntrance = String(entrance).trim();
            const targetsArr = msg.targetValue ? msg.targetValue.split(',').map(s => String(s).trim()) : [];

            if (msg.targetType === 'all') {
                isTarget = true;
            } else if (msg.targetType === 'entrance' && targetsArr.includes(safeEntrance)) {
                isTarget = true;
            } else if (msg.targetType === 'apartment' && targetsArr.includes(safeApt)) {
                isTarget = true;
            }

            if (isTarget) {
                count++;
                const isRead = msg.readBy && msg.readBy[apt]; // Чи читала це квартира?
                if (!isRead) unreadMsgIds.push(d.id); // Записуємо ID непрочитаних
                
                const dateStr = msg.createdAt ? new Date(msg.createdAt.toMillis()).toLocaleString('uk-UA', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}) : 'Нещодавно';
                
                // Індикатор наявності файлів (окремо фото, окремо документи)
                let hasFilesIcon = '';
                if (msg.attachments && msg.attachments.length > 0) {
                    const imgCount = msg.attachments.filter(isImageFile).length;
                    const docCount = msg.attachments.length - imgCount;
                    let parts = [];
                    if (imgCount > 0) parts.push(`🖼️ ${imgCount}`);
                    if (docCount > 0) parts.push(`📎 ${docCount}`);
                    hasFilesIcon = `<span style="font-size: 12px; color: var(--apple-blue); margin-left: 6px; white-space: nowrap;">${parts.join(' ')}</span>`;
                }
                let linkedDocBtnHtml = '';
                if (msg.linkedDoc) {
                    const docDataStr = encodeURIComponent(JSON.stringify(msg.linkedDoc));
                    linkedDocBtnHtml = `<div style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed #E5E5EA;">
                        <button class="btn-open-osbb-doc" data-doc="${docDataStr}" style="display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; background: #E5F0FF; color: var(--apple-blue); border: none; padding: 10px; border-radius: 12px; font-weight: 600; font-size: 14px; cursor: pointer;">
                            <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                            Ознайомитись: ${escapeHtml(msg.linkedDoc.name)}
                        </button>
                    </div>`;
                }
                html += `
                    <div class="message-card-item" data-id="${d.id}" data-title="${encodeURIComponent(msg.title)}" data-body="${encodeURIComponent(msg.body)}" data-date="${dateStr}" data-files='${encodeURIComponent(JSON.stringify(msg.attachments || []))}' style="border-bottom: 1px solid #F0F0F0; padding-bottom: 12px; margin-bottom: 12px; cursor: pointer;">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
                            <strong style="font-size: 15px; color: ${isRead ? 'var(--text-main)' : 'var(--apple-blue)'};">${msg.title} ${hasFilesIcon}</strong>
                            <span style="font-size: 11px; color: #A1A1A6; white-space: nowrap;">${dateStr}</span>
                        </div>
                        <p style="margin: 0; font-size: 14px; color: var(--text-muted); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${msg.body}</p>
                        ${linkedDocBtnHtml}
                    </div>`;
            }
        });

        list.innerHTML = count > 0 ? html : '<p style="font-size: 14px; color: var(--text-muted); text-align: center;">Немає нових повідомлень.</p>';
        badge.innerText = unreadMsgIds.length > 9 ? '9+' : unreadMsgIds.length;
        badge.style.display = unreadMsgIds.length > 0 ? 'flex' : 'none';

    } catch(e) {
        console.error("Помилка завантаження новин:", e);
    }
}

// 2. Логіка кліку по дзвіночку (ВІДМІТКА "ПРОЧИТАНО")
document.getElementById('bellBtn').addEventListener('click', async (e) => {
    // Якщо меню відкрито і є непрочитані - маркуємо їх
    if (document.getElementById('notifPopup').style.display === 'block' && unreadMsgIds.length > 0) {
        document.getElementById('notifBadge').style.display = 'none';
        
        // Генеруємо поточний час (наприклад: 21.08.2026, 14:30)
        const now = new Date().toLocaleString('uk-UA', {day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'});
        
        // Відправляємо відмітки в базу даних
        for (let id of unreadMsgIds) {
            try {
                await updateDoc(doc(db, "messages", id), {
                    [`readBy.${currentAptForMessages}`]: now
                });
            } catch(error) { console.error("Помилка оновлення статусу:", error); }
        }
        unreadMsgIds = []; // Очищаємо чергу
    }
});

// 3. Завантаження історії для Адміністратора
async function loadAdminMessageHistory() {
    const container = document.getElementById('adminMsgHistoryContainer');
    if(!container) return;
    container.innerHTML = '<p style="text-align: center; color:#888;">Завантаження історії...</p>';
    
    try {
        const q = query(collection(db, "messages"), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        
        if (snap.empty) {
            container.innerHTML = '<p style="color: var(--text-muted); font-size: 14px; text-align: center;">Історія порожня.</p>';
            return;
        }

        let html = '';
        const attachmentsMap = [];
        snap.forEach(d => {
            const msg = d.data();
            const dateStr = msg.createdAt ? new Date(msg.createdAt.toMillis()).toLocaleString('uk-UA', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}) : 'Нещодавно';
            
            // Формуємо красивий текст одержувачів
            let targetText = "Усьому будинку";
            if (msg.targetType === 'entrance') targetText = `Парадні: ${msg.targetValue}`;
            if (msg.targetType === 'apartment') targetText = `Квартири: ${msg.targetValue}`;

            // Формуємо бейджі прочитання
            let readHtml = '';
            if (msg.readBy && Object.keys(msg.readBy).length > 0) {
                for (let [aptNum, time] of Object.entries(msg.readBy)) {
                    readHtml += `<span style="display:inline-block; background: #E8F5E9; color: var(--apple-green); padding: 4px 8px; border-radius: 8px; font-size: 11px; margin: 3px 3px 0 0; font-weight: 600;">Кв.${aptNum} <span style="opacity:0.7; font-weight:400;">${time}</span></span>`;
                }
            } else {
                readHtml = '<span style="font-size: 12px; color: var(--text-muted);">Ще ніхто не прочитав</span>';
            }

            attachmentsMap.push({ id: d.id, files: msg.attachments || [] });

            html += `
                <div style="background: #F2F2F7; padding: 16px; border-radius: 14px;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
                        <strong style="font-size: 16px; color: var(--text-main);">${msg.title}</strong>
                        <span style="font-size: 11px; color: #A1A1A6;">${dateStr}</span>
                    </div>
                    <p style="font-size: 12px; color: var(--apple-blue); margin: 0 0 8px 0; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Кому: ${targetText}</p>
                    <p style="font-size: 14px; color: var(--text-main); margin: 0 0 12px 0; line-height: 1.4;">${msg.body}</p>

                    <div class="hist-attach-container" data-hist-id="${d.id}" style="display: none; flex-direction: column; margin-bottom: 12px;"></div>
                    
                    <div style="border-top: 1px solid #E5E5EA; padding-top: 10px;">
                        <span style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; display: block; margin-bottom: 4px;">Прочитали:</span>
                        ${readHtml}
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;

        // Рендеримо вкладення (фото/документи) для кожного повідомлення в історії
        attachmentsMap.forEach(item => {
            if (item.files && item.files.length > 0) {
                const holder = container.querySelector(`.hist-attach-container[data-hist-id="${item.id}"]`);
                if (holder) renderAttachments(holder, item.files);
            }
        });
    } catch(e) {
        console.error("Помилка завантаження історії:", e);
        container.innerHTML = '<p style="color: var(--apple-red); font-size: 14px; text-align: center;">Помилка завантаження.</p>';
    }
}

// Прив'язуємо кнопку оновлення історії
document.getElementById('refreshHistoryBtn')?.addEventListener('click', loadAdminMessageHistory);

// Логіка відкриття модального вікна при кліку на повідомлення
document.addEventListener('click', function(e) {
    const card = e.target.closest('.message-card-item');
    if (card) {
        const title = decodeURIComponent(card.getAttribute('data-title'));
        const body = decodeURIComponent(card.getAttribute('data-body'));
        const date = card.getAttribute('data-date');
        const files = JSON.parse(decodeURIComponent(card.getAttribute('data-files')));

        document.getElementById('modalMsgTitle').innerText = title;
        document.getElementById('modalMsgDate').innerText = date;
        document.getElementById('modalMsgBody').innerText = body; // Зберігає повне форматування (пробіли, абзаци)

        // Рендеримо вкладені файли (фото окремо, документи окремо)
        renderAttachments(document.getElementById('modalMsgAttachments'), files);

        document.getElementById('msgModal').style.display = 'flex';
    }
});

// Закриття модального вікна
document.getElementById('closeMsgModal').addEventListener('click', () => {
    document.getElementById('msgModal').style.display = 'none';
});
window.addEventListener('click', (e) => {
    const modal = document.getElementById('msgModal');
    if (e.target === modal) modal.style.display = 'none';
});

// ==========================================
// ВКЛАДЕННЯ: ВИЗНАЧЕННЯ ТИПУ ФАЙЛУ
// ==========================================

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getFileExt(name) {
    if (!name) return '';
    const parts = name.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function isImageFile(att) {
    if (att.type && att.type.startsWith('image/')) return true;
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'].includes(getFileExt(att.name));
}

function getDocKind(att) {
    const ext = getFileExt(att.name);
    if (ext === 'pdf' || (att.type === 'application/pdf')) return 'pdf';
    if (['doc', 'docx'].includes(ext)) return 'word';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return 'excel';
    if (['ppt', 'pptx'].includes(ext)) return 'powerpoint';
    if (['zip', 'rar', '7z'].includes(ext)) return 'archive';
    return 'file';
}

function formatFileSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' КБ';
    return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
}

function docIconSvg(kind) {
    const icons = {
        pdf: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="9" y1="15" x2="15" y2="15"></line><line x1="9" y1="11" x2="12" y2="11"></line></svg>',
        word: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="10" y2="17"></line><line x1="10" y1="17" x2="12" y2="13"></line><line x1="12" y1="13" x2="14" y2="17"></line><line x1="14" y1="17" x2="16" y2="13"></line></svg>',
        excel: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="19"></line><line x1="16" y1="13" x2="8" y2="19"></line></svg>',
        powerpoint: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><rect x="8" y="12" width="5" height="6" rx="1"></rect></svg>',
        archive: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"></path><path d="M1 3h22v5H1z"></path><line x1="10" y1="12" x2="14" y2="12"></line></svg>',
        file: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>'
    };
    return icons[kind] || icons.file;
}

// Головна функція рендеру вкладень: фото — сіткою, документи — картками
function renderAttachments(container, files) {
    if (!container) return;
    container.innerHTML = '';
    if (!files || files.length === 0) {
        container.style.display = 'none';
        return;
    }
    container.style.display = 'flex';
    container.style.flexDirection = 'column'; // ДОДАНО: Розміщує елементи чітко зверху вниз
    container.style.gap = '8px';              // ДОДАНО: Акуратний відступ між підписом і фото

    const images = files.filter(isImageFile);
    const docs = files.filter(f => !isImageFile(f));

    let html = '';

    if (images.length > 0) {
        html += `<span class="attach-label">Фото (${images.length})</span>`;
        html += `<div class="image-attach-grid">`;
        images.forEach((img, idx) => {
            html += `<div class="image-attach-thumb" data-gallery-index="${idx}">
                        <img src="${img.url}" loading="lazy" alt="${escapeHtml(img.name)}">
                     </div>`;
        });
        html += `</div>`;
    }

    if (docs.length > 0) {
        html += `<span class="attach-label" style="margin-top: ${images.length ? '14px' : '0'};">Документи (${docs.length})</span>`;
        html += `<div class="doc-attach-list">`;
        docs.forEach((d, idx) => {
            const kind = getDocKind(d);
            html += `<div class="doc-attach-row" data-doc-index="${idx}">
                        <div class="doc-attach-icon doc-icon-${kind}">${docIconSvg(kind)}</div>
                        <div class="doc-attach-info">
                            <span class="doc-attach-name">${escapeHtml(d.name || 'Документ')}</span>
                            <span class="doc-attach-meta">${formatFileSize(d.size)}</span>
                        </div>
                        <svg class="doc-attach-chevron" viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><polyline points="9 18 15 12 9 6"></polyline></svg>
                     </div>`;
        });
        html += `</div>`;
    }

    container.innerHTML = html;

    container.querySelectorAll('.image-attach-thumb').forEach(el => {
        el.addEventListener('click', () => openGallery(images, parseInt(el.getAttribute('data-gallery-index'))));
    });
    container.querySelectorAll('.doc-attach-row').forEach(el => {
        el.addEventListener('click', () => openDocViewer(docs[parseInt(el.getAttribute('data-doc-index'))]));
    });
}

// ==========================================
// ПОВНОЕКРАННА ГАЛЕРЕЯ ФОТО (СВАЙП + ЗУМ)
// ==========================================
let galleryImages = [];
let galleryIndex = 0;

function openGallery(images, startIndex) {
    if (!images || images.length === 0) return;
    galleryImages = images;
    galleryIndex = startIndex || 0;

    const track = document.getElementById('galleryTrack');
    track.innerHTML = galleryImages.map(img => `<div class="gallery-slide"><img src="${img.url}" alt="${escapeHtml(img.name)}"></div>`).join('');
    track.style.transition = 'none';
    track.style.transform = `translateX(-${galleryIndex * 100}%)`;
    requestAnimationFrame(() => { track.style.transition = 'transform 0.3s ease'; });

    updateGalleryCounter();
    const multi = galleryImages.length > 1;
    document.getElementById('galleryPrevBtn').style.display = multi ? 'flex' : 'none';
    document.getElementById('galleryNextBtn').style.display = multi ? 'flex' : 'none';

    document.getElementById('imageGalleryModal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function updateGalleryCounter() {
    document.getElementById('galleryCounter').innerText = galleryImages.length > 1 ? `${galleryIndex + 1} / ${galleryImages.length}` : '';
}

function updateGalleryTransform() {
    document.getElementById('galleryTrack').style.transform = `translateX(-${galleryIndex * 100}%)`;
    updateGalleryCounter();
}

function goToSlide(newIndex) {
    newIndex = Math.max(0, Math.min(newIndex, galleryImages.length - 1));
    if (newIndex !== galleryIndex) {
        document.querySelectorAll('#galleryTrack img.zoomed').forEach(img => img.classList.remove('zoomed'));
    }
    galleryIndex = newIndex;
    document.getElementById('galleryTrack').style.transition = 'transform 0.3s ease';
    updateGalleryTransform();
}

function closeGallery() {
    document.getElementById('imageGalleryModal').classList.remove('active');
    document.getElementById('galleryTrack').innerHTML = '';
    document.body.style.overflow = '';
}

document.getElementById('galleryCloseBtn').addEventListener('click', closeGallery);
document.getElementById('galleryPrevBtn').addEventListener('click', () => goToSlide(galleryIndex - 1));
document.getElementById('galleryNextBtn').addEventListener('click', () => goToSlide(galleryIndex + 1));
document.getElementById('imageGalleryModal').addEventListener('click', (e) => {
    if (e.target.id === 'imageGalleryModal') closeGallery();
});

// Свайп-жести для гортання фото
let galleryTouchStartX = 0;
let galleryTouchCurrentX = 0;
let galleryDragging = false;
const galleryTrackEl = document.getElementById('galleryTrack');

galleryTrackEl.addEventListener('touchstart', (e) => {
    galleryTouchStartX = e.touches[0].clientX;
    galleryTouchCurrentX = galleryTouchStartX;
    galleryDragging = true;
    galleryTrackEl.style.transition = 'none';
});

galleryTrackEl.addEventListener('touchmove', (e) => {
    if (!galleryDragging) return;
    galleryTouchCurrentX = e.touches[0].clientX;
    const delta = galleryTouchCurrentX - galleryTouchStartX;
    galleryTrackEl.style.transform = `translateX(calc(-${galleryIndex * 100}% + ${delta}px))`;
});

galleryTrackEl.addEventListener('touchend', () => {
    galleryDragging = false;
    const delta = galleryTouchCurrentX - galleryTouchStartX;
    galleryTrackEl.style.transition = 'transform 0.3s ease';

    if (Math.abs(delta) > 60) {
        goToSlide(delta < 0 ? galleryIndex + 1 : galleryIndex - 1);
    } else if (Math.abs(delta) < 10) {
        // Це був тап, а не свайп — перемикаємо зум поточного фото
        const currentImg = galleryTrackEl.children[galleryIndex]?.querySelector('img');
        if (currentImg) currentImg.classList.toggle('zoomed');
        updateGalleryTransform();
    } else {
        updateGalleryTransform();
    }
    galleryTouchStartX = 0;
    galleryTouchCurrentX = 0;
});

// Клавіатура (для десктопу/тестування)
document.addEventListener('keydown', (e) => {
    if (!document.getElementById('imageGalleryModal').classList.contains('active')) return;
    if (e.key === 'ArrowLeft') goToSlide(galleryIndex - 1);
    if (e.key === 'ArrowRight') goToSlide(galleryIndex + 1);
    if (e.key === 'Escape') closeGallery();
});

// ==========================================
// ПОВНОЕКРАННИЙ ПЕРЕГЛЯДАЧ ДОКУМЕНТІВ
// ==========================================
function openDocViewer(docFile) {
    if (!docFile) return;
    const kind = getDocKind(docFile);

    document.getElementById('docViewerTitle').innerText = docFile.name || 'Документ';
    document.getElementById('docViewerOpenExternal').href = docFile.url;

    const body = document.getElementById('docViewerBody');

    if (kind === 'pdf' || ['word', 'excel', 'powerpoint'].includes(kind)) {
        // Google Docs Viewer рендерить документ як звичайну веб-сторінку (з гортанням усіх сторінок),
        // тому працює однаково надійно в будь-якому мобільному браузері/вбудованому вікні —
        // на відміну від прямого iframe на PDF, який в деяких webview показує лише 1-шу сторінку.
        const viewerUrl = `https://docs.google.com/gview?url=${encodeURIComponent(docFile.url)}&embedded=true`;
        body.innerHTML = `
            <iframe src="${viewerUrl}" class="doc-viewer-iframe"></iframe>
            <p class="doc-viewer-fallback-note">Якщо файл не відкрився — натисніть кнопку "стрілка" вгорі, щоб відкрити його у відповідному застосунку.</p>`;
    } else {
        body.innerHTML = `
            <div class="doc-viewer-generic">
                <div class="doc-attach-icon doc-icon-${kind}" style="width: 72px; height: 72px;">${docIconSvg(kind)}</div>
                <p>Перегляд цього типу файлів недоступний прямо в застосунку.</p>
                <a href="${docFile.url}" target="_blank" class="btn btn-primary" style="width: auto; padding: 12px 24px; display: inline-block; text-decoration: none; text-align: center;">Відкрити файл</a>
            </div>`;
    }

    document.getElementById('docViewerModal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeDocViewer() {
    document.getElementById('docViewerModal').classList.remove('active');
    document.getElementById('docViewerBody').innerHTML = '';
    document.body.style.overflow = '';
}

document.getElementById('docViewerCloseBtn').addEventListener('click', closeDocViewer);

// ==========================================
// СТАТУС ЕЛЕКТРОПОСТАЧАННЯ (ТУМБЛЕР АДМІНА + ЖИВЕ ОНОВЛЕННЯ)
// ==========================================
let powerUnsubscribe = null;
let powerChangedAtMs = null;
let powerIsOn = true;
let powerDurationInterval = null;

function bulbSvg(isOn) {
    if (isOn) {
        return `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18h6"></path>
            <path d="M10 22h4"></path>
            <path d="M12 2a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 2z" fill="currentColor" fill-opacity="0.18"></path>
            <line x1="12" y1="0.5" x2="12" y2="2"></line>
            <line x1="20" y1="4" x2="18.5" y2="5.5"></line>
            <line x1="4" y1="4" x2="5.5" y2="5.5"></line>
        </svg>`;
    }
    return `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18h6"></path>
        <path d="M10 22h4"></path>
        <path d="M12 2a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 2z"></path>
    </svg>`;
}

function formatDateTimeUk(date) {
    return date.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatElapsed(ms) {
    if (ms < 0) ms = 0;
    const totalMin = Math.floor(ms / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (days > 0) return `${days} дн. ${hours} год.`;
    if (hours > 0) return `${hours} год. ${mins} хв.`;
    return `${mins} хв.`;
}

function updatePowerDuration() {
    if (powerChangedAtMs == null) return;
    const elapsed = formatElapsed(Date.now() - powerChangedAtMs);
    const label = powerIsOn ? `Вже ${elapsed}` : `Вже ${elapsed} без світла`;
    const durationText = document.getElementById('powerDurationText');
    const adminDurationText = document.getElementById('adminPowerDurationText');
    if (durationText) durationText.innerText = label;
    if (adminDurationText) adminDurationText.innerText = label;
}

function renderPowerStatus(isOn, changedAtDate) {
    powerIsOn = isOn;
    powerChangedAtMs = changedAtDate ? changedAtDate.getTime() : null;
    const sinceStr = changedAtDate ? `з ${formatDateTimeUk(changedAtDate)}` : '';

    // Картка мешканця
    const card = document.getElementById('powerCard');
    const statusText = document.getElementById('powerStatusText');
    const sinceText = document.getElementById('powerSinceText');
    const iconWrap = document.getElementById('powerIconCircle');

    if (card) { card.classList.toggle('power-card-on', isOn); card.classList.toggle('power-card-off', !isOn); }
    if (statusText) statusText.innerText = isOn ? 'Є світло' : 'Немає світла';
    if (sinceText) sinceText.innerText = sinceStr;
    if (iconWrap) iconWrap.innerHTML = bulbSvg(isOn);

    // Картка адміна + тумблер
    const adminCard = document.getElementById('adminPowerCard');
    const adminStatusText = document.getElementById('adminPowerStatusText');
    const adminSinceText = document.getElementById('adminPowerSinceText');
    const adminIconWrap = document.getElementById('adminPowerIconWrap');
    const toggleInput = document.getElementById('powerToggleInput');

    if (adminCard) { adminCard.classList.toggle('power-card-on', isOn); adminCard.classList.toggle('power-card-off', !isOn); }
    if (adminStatusText) adminStatusText.innerText = isOn ? 'Світло є' : 'Світла немає';
    if (adminSinceText) adminSinceText.innerText = sinceStr;
    if (adminIconWrap) adminIconWrap.innerHTML = bulbSvg(isOn);
    if (toggleInput) toggleInput.checked = isOn;

    updatePowerDuration();
}

function startPowerStatusListener() {
    if (powerUnsubscribe) return; // вже слухаємо
    powerUnsubscribe = onSnapshot(doc(db, "status", "power"), (snap) => {
        if (snap.exists()) {
            const data = snap.data();
            const changedAtDate = data.changedAt ? data.changedAt.toDate() : null;
            renderPowerStatus(data.isOn !== false, changedAtDate);
        } else {
            renderPowerStatus(true, null);
        }
    }, (error) => {
        console.error("Помилка стеження за статусом електропостачання:", error);
    });

    if (!powerDurationInterval) {
        powerDurationInterval = setInterval(updatePowerDuration, 30000);
    }
}

function stopPowerStatusListener() {
    if (powerUnsubscribe) { powerUnsubscribe(); powerUnsubscribe = null; }
    if (powerDurationInterval) { clearInterval(powerDurationInterval); powerDurationInterval = null; }
}

// Тумблер адміна: вмикає/вимикає світло для всіх користувачів одразу
document.getElementById('powerToggleInput')?.addEventListener('change', async function() {
    const newState = this.checked;
    this.disabled = true;
    try {
        await setDoc(doc(db, "status", "power"), {
            isOn: newState,
            changedAt: serverTimestamp()
        });
        // Оновлення інтерфейсу прилетить автоматично через onSnapshot
    } catch (error) {
        console.error("Помилка оновлення статусу електропостачання:", error);
        alert("Не вдалося оновити статус світла. Перевірте інтернет-з'єднання.");
        this.checked = !newState;
    } finally {
        this.disabled = false;
    }
});
// ==========================================
// БАЗА ДОКУМЕНТІВ ОСББ
// ==========================================

// Перемикання екранів
document.getElementById('menuDocsBtn').addEventListener('click', () => {
    closeAllSheets();
    document.getElementById('dataSection').style.display = 'none';
    document.getElementById('adminDashboardSection').style.display = 'none';
    document.getElementById('docsSection').style.display = 'block';
    loadOsbbDocsBase(); // Завантажуємо документи при відкритті
});

document.getElementById('backFromDocsBtn').addEventListener('click', async () => {
    document.getElementById('docsSection').style.display = 'none';
    
    // Перевіряємо, куди повертатися
    const aptRef = doc(db, "apartments", document.getElementById('displayAptNum').innerText || document.getElementById('hiddenAptInput').value);
    const snap = await getDoc(aptRef);
    if (snap.exists() && snap.data().isAdmin) {
        document.getElementById('adminDashboardSection').style.display = 'block';
    } else {
        document.getElementById('dataSection').style.display = 'block';
    }
});

// Завантаження документів у базу (Дія Адміна)
const uploadDocBtn = document.getElementById('uploadOsbbDocBtn');
if (uploadDocBtn) {
    uploadDocBtn.addEventListener('click', async () => {
        const title = document.getElementById('osbbDocTitle').value.trim();
        const category = document.getElementById('osbbDocCategory').value;
        const fileInput = document.getElementById('osbbDocFile');

        if (!title || !fileInput.files || fileInput.files.length === 0) {
            return alert('Будь ласка, введіть назву та оберіть файл.');
        }

        uploadDocBtn.innerText = 'Завантаження...';
        uploadDocBtn.disabled = true;

        try {
            const file = fileInput.files[0];
            const fileRef = sRef(storage, `osbb_docs/${Date.now()}_${file.name}`);
            await uploadBytes(fileRef, file);
            const url = await getDownloadURL(fileRef);

            await addDoc(collection(db, "osbb_documents"), {
                title: title,
                category: category,
                fileName: file.name,
                url: url,
                size: file.size,
                type: file.type || '',
                createdAt: serverTimestamp()
            });

            alert('Документ успішно додано до бази ОСББ!');
            document.getElementById('osbbDocTitle').value = '';
            fileInput.type = 'text'; fileInput.type = 'file';
            const docPreview = document.getElementById('osbbDocFilePreview');
            if (docPreview) docPreview.innerHTML = '';
            
            // Оновлюємо випадаючий список у новинах
            populateAdminDocsDropdown();
            
        } catch (e) {
            console.error(e);
            alert("Помилка завантаження.");
        } finally {
            uploadDocBtn.innerText = 'Завантажити в Базу';
            uploadDocBtn.disabled = false;
        }
    });
}

// Завантаження списку для перегляду
async function loadOsbbDocsBase() {
    const container = document.getElementById('osbbDocsContainer');
    container.innerHTML = '<p style="text-align:center; color:#888;">Завантаження документів...</p>';
    
    try {
        const q = query(collection(db, "osbb_documents"), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        
        if (snap.empty) {
            return container.innerHTML = '<p style="text-align:center; color: var(--text-muted);">База документів порожня.</p>';
        }

        const grouped = {};
        snap.forEach(d => {
            const data = d.data();
            if (!grouped[data.category]) grouped[data.category] = [];
            grouped[data.category].push(data);
        });

        let html = '';
        for (const [cat, docs] of Object.entries(grouped)) {
            html += `<div style="background: #FFF; border-radius: 20px; padding: 20px; box-shadow: 0 4px 24px rgba(0,0,0,0.04);">
                        <h3 style="margin: 0 0 15px 0; font-size: 18px; color: var(--apple-blue); border-bottom: 1px solid #eee; padding-bottom: 10px;">${cat}</h3>
                        <div class="doc-attach-list">`;
            
            docs.forEach((d, idx) => {
                const kind = getDocKind({ name: d.fileName, type: d.type }); // Виправлено пошук розширення
                const docDataStr = encodeURIComponent(JSON.stringify({url: d.url, name: d.title, type: d.type}));
                
                html += `<div class="doc-attach-row btn-open-osbb-doc" data-doc="${docDataStr}" style="background: #F9F9FB; border: 1px solid #E5E5EA;">
                            <div class="doc-attach-icon doc-icon-${kind}">${docIconSvg(kind)}</div>
                            <div class="doc-attach-info">
                                <span class="doc-attach-name" style="font-size: 15px;">${escapeHtml(d.title)}</span>
                                <span class="doc-attach-meta">${formatDateTimeUk(d.createdAt ? d.createdAt.toDate() : new Date())} • ${formatFileSize(d.size)}</span>
                            </div>
                            <svg viewBox="0 0 24 24" width="20" height="20" stroke="var(--apple-blue)" stroke-width="2" fill="none"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                         </div>`;
            });
            html += `</div></div>`;
        }
        container.innerHTML = html;

    } catch (e) {
        console.error(e);
        container.innerHTML = '<p style="text-align:center; color: var(--apple-red);">Помилка завантаження бази.</p>';
    }
}

// Заповнення випадаючого списку для розсилки (Адмін)
async function populateAdminDocsDropdown() {
    const select = document.getElementById('adminMsgLinkedDoc');
    if (!select) return;
    try {
        const q = query(collection(db, "osbb_documents"), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        let options = '<option value="">Не прикріплювати</option>';
        snap.forEach(d => {
            const data = d.data();
            const docDataStr = encodeURIComponent(JSON.stringify({url: data.url, name: data.title, type: data.type}));
            options += `<option value="${docDataStr}">${data.category}: ${data.title}</option>`;
        });
        select.innerHTML = options;
    } catch (e) { console.error("Помилка завантаження списку доків", e); }
}

// Слухач для відкриття документів ОСББ (як із бази, так і з посилання в новинах)
document.addEventListener('click', function(e) {
    const docBtn = e.target.closest('.btn-open-osbb-doc');
    if (docBtn) {
        e.stopPropagation(); // Щоб не відкривалась модалка повідомлення, якщо клікнули в новинах
        const docData = JSON.parse(decodeURIComponent(docBtn.getAttribute('data-doc')));
        openDocViewer(docData); // Викликаємо ідеальний переглядач Клода
    }
});
// ==========================================
// СИСТЕМА ЗВЕРНЕНЬ ЖИЛЬЦІВ (ТИКЕТИ)
// ==========================================

// --- НАВІГАЦІЯ ---
document.getElementById('menuRequestsBtn')?.addEventListener('click', () => {
    closeAllSheets();
    document.getElementById('dataSection').style.display = 'none';
    document.getElementById('adminDashboardSection').style.display = 'none';
    document.getElementById('docsSection').style.display = 'none';
    document.getElementById('requestsSection').style.display = 'block';
    
    // Автоматично підлаштовуємо висоту textarea
    const reqBody = document.getElementById('userReqBody');
    if (reqBody) {
        reqBody.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
        });
    }
    
    const apt = document.getElementById('displayAptNum').innerText;
    loadUserRequestsHistory(apt);
});

document.getElementById('backFromRequestsBtn')?.addEventListener('click', async () => {
    document.getElementById('requestsSection').style.display = 'none';
    document.getElementById('dataSection').style.display = 'block';
});

// --- СТВОРЕННЯ ЗВЕРНЕННЯ ЖИЛЬЦЕМ ---
document.getElementById('sendUserReqBtn')?.addEventListener('click', async () => {
    const text = document.getElementById('userReqBody').value.trim();
    const fileInput = document.getElementById('userReqFiles');
    const apt = document.getElementById('displayAptNum').innerText;

    if (!text && (!fileInput.files || fileInput.files.length === 0)) {
        return alert("Будь ласка, напишіть текст або прикріпіть файл.");
    }

    const btn = document.getElementById('sendUserReqBtn');
    btn.innerText = 'Надсилання...';
    btn.disabled = true;

    try {
        let fileUrls = [];
        if (fileInput && fileInput.files.length > 0) {
            for (let i = 0; i < fileInput.files.length; i++) {
                const file = fileInput.files[i];
                const fileRef = sRef(storage, `requests/${Date.now()}_${file.name}`);
                await uploadBytes(fileRef, file);
                const url = await getDownloadURL(fileRef);
                fileUrls.push({ name: file.name, url: url, type: file.type || '', size: file.size || 0 });
            }
        }

        await addDoc(collection(db, "requests"), {
            apt: apt,
            text: text,
            attachments: fileUrls,
            createdAt: serverTimestamp(),
            status: 'new', // 'new' або 'replied'
            replyText: null,
            replyAttachments: [],
            repliedAt: null
        });

        alert("Ваше звернення успішно надіслано Правлінню!");
        document.getElementById('userReqBody').value = '';
        document.getElementById('userReqBody').style.height = 'auto';
        if (fileInput) { fileInput.type = 'text'; fileInput.type = 'file'; }
        
        loadUserRequestsHistory(apt);
    } catch (e) {
        console.error(e);
        alert("Помилка надсилання звернення.");
    } finally {
        btn.innerText = 'Надіслати Правлінню';
        btn.disabled = false;
    }
});

// --- ВІДОБРАЖЕННЯ ЗВЕРНЕНЬ ДЛЯ ЖИЛЬЦЯ ---
async function loadUserRequestsHistory(apt) {
    const container = document.getElementById('userRequestsContainer');
    if (!container) return;
    container.innerHTML = '<p style="text-align:center; color:#888;">Завантаження...</p>';

    try {
        const q = query(collection(db, "requests"), where("apt", "==", apt));
        const snap = await getDocs(q);
        
        // Сортуємо локально, щоб не створювати композитні індекси в Firebase
        let requests = [];
        snap.forEach(d => requests.push({ id: d.id, ...d.data() }));
        requests.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));

        if (requests.length === 0) {
            return container.innerHTML = '<p style="text-align: center; color: var(--text-muted); font-size: 14px;">Немає звернень.</p>';
        }

        let html = '';
        requests.forEach(req => {
            const dateStr = req.createdAt ? new Date(req.createdAt.toMillis()).toLocaleString('uk-UA', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}) : 'Нещодавно';
            
            // Бульбашка жильця (Дизайн преміум-картки як на головному екрані)
            html += `<div class="card premium-widget-card" style="background: #FFF; border-radius: 20px; padding: 20px; box-shadow: 0 4px 24px rgba(0,0,0,0.03); margin-bottom: ${req.status === 'replied' ? '12px' : '24px'}; border: 1px solid #E5E5EA;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <span style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Ваше звернення</span>
                    <span style="font-size: 12px; color: #A1A1A6;">${dateStr}</span>
                </div>
                <p style="margin: 0 0 12px 0; font-size: 16px; color: var(--text-main); white-space: pre-wrap; word-break: break-word; line-height: 1.4;">${escapeHtml(req.text)}</p>
                <div class="user-req-attach" data-req-id="${req.id}"></div>
            </div>`;

            // Відповідь адміна (якщо є)
            if (req.status === 'replied') {
                const replyDateStr = req.repliedAt ? new Date(req.repliedAt.toMillis()).toLocaleString('uk-UA', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}) : '';
                html += `<div class="card premium-widget-card" style="background: #F0F8FF; border-radius: 20px; padding: 20px; box-shadow: 0 4px 24px rgba(0,0,0,0.03); margin-bottom: 24px; margin-left: 20px; border: 1px solid rgba(0, 122, 255, 0.1);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <span style="font-size: 11px; font-weight: 700; color: var(--apple-blue); text-transform: uppercase; letter-spacing: 0.5px;">Відповідь Правління</span>
                        <span style="font-size: 12px; color: var(--apple-blue); opacity: 0.7;">${replyDateStr}</span>
                    </div>
                    <p style="margin: 0 0 12px 0; font-size: 16px; color: var(--text-main); white-space: pre-wrap; word-break: break-word; line-height: 1.4;">${escapeHtml(req.replyText)}</p>
                    <div class="user-req-reply-attach" data-req-id="${req.id}"></div>
                </div>`;
            }
        });
        
        container.innerHTML = html;

        // Рендеринг вкладень
        requests.forEach(req => {
            const attContainer = container.querySelector(`.user-req-attach[data-req-id="${req.id}"]`);
            if (attContainer) renderAttachments(attContainer, req.attachments);

            if (req.status === 'replied') {
                const repContainer = container.querySelector(`.user-req-reply-attach[data-req-id="${req.id}"]`);
                if (repContainer) renderAttachments(repContainer, req.replyAttachments);
            }
        });

    } catch (e) {
        console.error(e);
        container.innerHTML = '<p style="text-align:center; color: var(--apple-red);">Помилка завантаження.</p>';
    }
}

// --- ВІДОБРАЖЕННЯ ЗВЕРНЕНЬ ДЛЯ АДМІНА ---
async function loadAdminRequests() {
    const container = document.getElementById('adminRequestsContainer');
    if (!container) return;
    container.innerHTML = '<p style="text-align: center; color:#888;">Завантаження...</p>';

    try {
        const q = query(collection(db, "requests"), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        
        const reqBadge = document.getElementById('adminReqBadge');

        if (snap.empty) {
            if (reqBadge) reqBadge.style.display = 'none';
            return container.innerHTML = '<p class="list-empty">Немає звернень від мешканців.</p>';
        }

        let html = '';
        let requestsData = [];
        let pendingCount = 0;

        snap.forEach(d => {
            const req = d.data();
            requestsData.push({ id: d.id, ...req });
            
            const dateStr = req.createdAt ? new Date(req.createdAt.toMillis()).toLocaleString('uk-UA', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}) : 'Нещодавно';
            const isReplied = req.status === 'replied';
            if (!isReplied) pendingCount++;

            html += `<div class="req-card ${isReplied ? 'req-done' : 'req-pending'}">
                <div class="req-head">
                    <div class="req-apt-badge">${escapeHtml(String(req.apt))}</div>
                    <div class="req-head-text">
                        <span class="req-apt-label">Квартира ${escapeHtml(String(req.apt))}</span>
                        <span class="req-date">${dateStr}</span>
                    </div>
                    <span class="req-status ${isReplied ? 'req-status-done' : 'req-status-new'}">${isReplied ? 'Відповіли' : 'Нове'}</span>
                </div>
                <p class="req-text">${escapeHtml(req.text)}</p>
                <div class="admin-req-attach" data-req-id="${d.id}"></div>
                ${isReplied ? '' :
                `<button class="btn-cta btn-cta-compact btn-open-reply" data-id="${d.id}" data-apt="${req.apt}" data-text="${encodeURIComponent(req.text)}">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
                    Відповісти
                </button>`}
            </div>`;
        });

        container.innerHTML = html;

        // Лічильник неопрацьованих звернень на вкладці
        if (reqBadge) {
            reqBadge.innerText = pendingCount;
            reqBadge.style.display = pendingCount > 0 ? 'flex' : 'none';
        }

        // Рендеримо вкладення
        requestsData.forEach(req => {
            const attContainer = container.querySelector(`.admin-req-attach[data-req-id="${req.id}"]`);
            if (attContainer) renderAttachments(attContainer, req.attachments);
        });

        // Вішаємо слухачі на кнопки відповіді
        container.querySelectorAll('.btn-open-reply').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = btn.getAttribute('data-id');
                const apt = btn.getAttribute('data-apt');
                const text = decodeURIComponent(btn.getAttribute('data-text'));
                
                document.getElementById('replyModalReqId').value = id;
                document.getElementById('replyModalReqApt').value = apt;
                document.getElementById('replyModalTitle').innerText = `Відповідь кв. ${apt}`;
                document.getElementById('replyModalOriginalText').innerText = text;
                document.getElementById('replyModalBody').value = '';
                const fileInp = document.getElementById('replyModalFiles');
                if(fileInp) { fileInp.type = 'text'; fileInp.type = 'file'; }

                document.getElementById('adminReplyModal').style.display = 'flex';
            });
        });

    } catch (e) {
        console.error(e);
        container.innerHTML = '<p style="text-align:center; color: var(--apple-red);">Помилка завантаження звернень.</p>';
    }
}

// Щоб адмін бачив звернення при вході
const originalLoadAdminMessageHistory = loadAdminMessageHistory;
loadAdminMessageHistory = async function() {
    await originalLoadAdminMessageHistory();
    await loadAdminRequests(); // Додаємо завантаження звернень
};

// --- НАДСИЛАННЯ ВІДПОВІДІ АДМІНОМ ---
document.getElementById('sendReplyBtn')?.addEventListener('click', async () => {
    const id = document.getElementById('replyModalReqId').value;
    const text = document.getElementById('replyModalBody').value.trim();
    const fileInput = document.getElementById('replyModalFiles');

    if (!text && (!fileInput.files || fileInput.files.length === 0)) {
        return alert("Напишіть текст відповіді або прикріпіть файл.");
    }

    const btn = document.getElementById('sendReplyBtn');
    btn.innerText = 'Надсилання...';
    btn.disabled = true;

    try {
        let fileUrls = [];
        if (fileInput && fileInput.files.length > 0) {
            for (let i = 0; i < fileInput.files.length; i++) {
                const file = fileInput.files[i];
                const fileRef = sRef(storage, `requests_replies/${Date.now()}_${file.name}`);
                await uploadBytes(fileRef, file);
                const url = await getDownloadURL(fileRef);
                fileUrls.push({ name: file.name, url: url, type: file.type || '', size: file.size || 0 });
            }
        }

        // Оновлюємо документ тикета
        await updateDoc(doc(db, "requests", id), {
            status: 'replied',
            replyText: text,
            replyAttachments: fileUrls,
            repliedAt: serverTimestamp()
        });

        alert("Відповідь успішно надіслано!");
        document.getElementById('adminReplyModal').style.display = 'none';
        
        loadAdminRequests(); // Оновлюємо список
    } catch (e) {
        console.error(e);
        alert("Помилка надсилання відповіді.");
    } finally {
        btn.innerText = 'Надіслати відповідь';
        btn.disabled = false;
    }
});

// Закриття модалки відповіді
document.getElementById('closeReplyModalBtn')?.addEventListener('click', () => {
    document.getElementById('adminReplyModal').style.display = 'none';
});

// ==========================================
// НАВІГАЦІЯ: ПРАВЛІННЯ ТА КОНТАКТИ
// ==========================================

document.getElementById('menuBoardBtn')?.addEventListener('click', () => {
    // Ховаємо всі інші екрани
    closeAllSheets();
    document.getElementById('dataSection').style.display = 'none';
    document.getElementById('adminDashboardSection').style.display = 'none';
    if(document.getElementById('docsSection')) document.getElementById('docsSection').style.display = 'none';
    if(document.getElementById('requestsSection')) document.getElementById('requestsSection').style.display = 'none';
    
    // Показуємо екран Правління
    document.getElementById('boardSection').style.display = 'block';
});

document.getElementById('backFromBoardBtn')?.addEventListener('click', async () => {
    document.getElementById('boardSection').style.display = 'none';
    
    // Перевіряємо, куди повертатися (до кабінету адміна чи звичайного мешканця)
    const aptNum = document.getElementById('displayAptNum').innerText || document.getElementById('hiddenAptInput').value;
    const aptRef = doc(db, "apartments", aptNum);
    const snap = await getDoc(aptRef);
    
    if (snap.exists() && snap.data().isAdmin) {
        document.getElementById('adminDashboardSection').style.display = 'block';
    } else {
        document.getElementById('dataSection').style.display = 'block';
    }
});

// ==========================================
// ІНТЕРФЕЙС: ЧІПИ ОБРАНИХ ФАЙЛІВ
// ==========================================
function renderFileChips(input, holder) {
    if (!holder) return;
    holder.innerHTML = '';
    if (!input || !input.files || input.files.length === 0) return;

    Array.from(input.files).forEach((file, idx) => {
        const isImg = file.type && file.type.startsWith('image/');
        const kind = isImg ? 'image' : getDocKind({ name: file.name, type: file.type });
        const chip = document.createElement('div');
        chip.className = 'file-chip';
        chip.innerHTML = `
            <span class="file-chip-icon doc-icon-${isImg ? 'file' : kind}">
                ${isImg ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>' : docIconSvg(kind)}
            </span>
            <span class="file-chip-name">${escapeHtml(file.name)}</span>
            <span class="file-chip-size">${formatFileSize(file.size)}</span>`;
        holder.appendChild(chip);
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'file-chip-clear';
    clearBtn.innerText = 'Очистити список';
    clearBtn.addEventListener('click', () => { input.value = ''; holder.innerHTML = ''; });
    holder.appendChild(clearBtn);
}

// Прив'язуємо превʼю до полів завантаження в адмінці
const adminMsgFilesInput = document.getElementById('adminMsgFiles');
const adminMsgFilesPreview = document.getElementById('adminMsgFilesPreview');
if (adminMsgFilesInput && adminMsgFilesPreview) {
    adminMsgFilesInput.addEventListener('change', () => renderFileChips(adminMsgFilesInput, adminMsgFilesPreview));
}
const osbbDocFileInput = document.getElementById('osbbDocFile');
const osbbDocFilePreview = document.getElementById('osbbDocFilePreview');
if (osbbDocFileInput && osbbDocFilePreview) {
    osbbDocFileInput.addEventListener('change', () => renderFileChips(osbbDocFileInput, osbbDocFilePreview));
}

// ==========================================
// АДМІНКА: ВКЛАДКИ (мобільна навігація)
// ==========================================
document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-tab');
        document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t === tab));
        document.querySelectorAll('.admin-panel').forEach(p => {
            p.classList.toggle('active', p.getAttribute('data-panel') === target);
        });
        // Прокручуємо до початку вкладки, щоб не губитися на мобільному
        const tabsEl = document.getElementById('adminTabs');
        if (tabsEl) window.scrollTo({ top: Math.max(0, tabsEl.offsetTop - 70), behavior: 'smooth' });
    });
});

// ==========================================
// АДМІНКА: СЕГМЕНТОВАНИЙ ВИБІР ОДЕРЖУВАЧІВ
// ==========================================
document.querySelectorAll('#adminTargetSegmented .segmented-item').forEach(item => {
    item.addEventListener('click', () => {
        const value = item.getAttribute('data-target');
        document.querySelectorAll('#adminTargetSegmented .segmented-item')
            .forEach(i => i.classList.toggle('active', i === item));

        // Синхронізуємо прихований <select>, на який спирається логіка відправки
        const select = document.getElementById('adminMsgTargetType');
        select.value = value;
        select.dispatchEvent(new Event('change'));
    });
});

// ==========================================
// ЛІЧИЛЬНИК СПІВВЛАСНИКІВ У ГЕРОЙ-КАРТЦІ
// ==========================================
function updateOwnersCount() {
    const el = document.getElementById('displayOwnersCount');
    if (!el || !ownersContainer) return;
    const filled = Array.from(ownersContainer.querySelectorAll('.owner-card'))
        .filter(c => {
            const nameEl = c.querySelector('.v-name');
            const text = nameEl ? nameEl.innerText.trim() : '';
            return text && text !== 'Новий співвласник';
        }).length;
    el.innerText = filled > 0 ? filled : '—';
}

// Слідкуємо за змінами списку співвласників, щоб лічильник завжди був актуальним
if (ownersContainer) {
    new MutationObserver(updateOwnersCount).observe(ownersContainer, { childList: true, subtree: true });
}

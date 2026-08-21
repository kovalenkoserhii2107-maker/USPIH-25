// 1. ПІДКЛЮЧЕННЯ FIREBASE
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, collection, getDocs, addDoc, deleteDoc, updateDoc, query, orderBy, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
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
    } else {
        appLoader.style.display = 'none'; 
        loginSection.style.display = 'block'; 
        dataSection.style.display = 'none';
        topNav.style.display = 'none';
        passwordSection.style.display = 'none';
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
        
        // Тут ми пізніше додамо завантаження статистики або історії надісланих повідомлень
        
    } else {
        // ШЛЯХ Б: Це звичайний мешканець
        topNav.style.display = "block";
        dataSection.style.display = "block";
        
        // Заповнюємо дані картки мешканця
        document.getElementById('displayAptNum').innerText = apt;
        document.getElementById('displayEntranceNum').innerText = entranceVal;
        document.getElementById('displayAreaVal').innerText = areaVal;

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

bellBtn.addEventListener('click', (e) => {
    e.stopPropagation(); menuPopup.style.display = 'none';
    notifPopup.style.display = notifPopup.style.display === 'none' ? 'block' : 'none';
    document.getElementById('notifBadge').style.display = 'none';
});
menuBtn.addEventListener('click', (e) => {
    e.stopPropagation(); notifPopup.style.display = 'none';
    menuPopup.style.display = menuPopup.style.display === 'none' ? 'block' : 'none';
});
document.addEventListener('click', (e) => {
    if (!notifPopup.contains(e.target) && !bellBtn.contains(e.target)) notifPopup.style.display = 'none';
    if (!menuPopup.contains(e.target) && !menuBtn.contains(e.target)) menuPopup.style.display = 'none';
});

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

    // Перевірка на порожні поля
    if (!title || !body) {
        alert('Будь ласка, заповніть заголовок та текст повідомлення.');
        return;
    }
    if (targetType !== 'all' && !targetValue) {
        alert('Будь ласка, вкажіть номери квартир або парадних для відправки.');
        return;
    }

    const btn = document.getElementById('adminSendMsgBtn');
    btn.innerText = 'Відправка...';
    btn.disabled = true;

    try {
        // ДОДАЄМО ДОКУМЕНТ В НОВУ КОЛЕКЦІЮ "messages"
        
        await addDoc(collection(db, "messages"), {
            title: title,
            body: body,
            targetType: targetType,     // 'all', 'entrance', 'apartment'
            targetValue: targetValue,   // '1, 3' або '45, 298'
            createdAt: serverTimestamp(),
            author: "Правління ОСББ",
            readBy: {}                  
        });

        loadAdminMessageHistory(); // ДОДАНО: Миттєво оновити історію після надсилання

        // Показуємо успіх і очищаємо форму
        alert('Повідомлення успішно надіслано!');
        
        document.getElementById('adminMsgTitle').value = '';
        document.getElementById('adminMsgBody').value = '';
        document.getElementById('adminMsgBody').style.height = 'auto'; // Повертаємо початкову висоту
        document.getElementById('adminMsgTargetValue').value = '';
        document.getElementById('adminMsgTargetType').value = 'all';
        document.getElementById('adminMsgTargetValueGroup').style.display = 'none';
        
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

function renderOwnerCard(ownerData, number, isEditMode, isNewAtTop = false) {
    const card = document.createElement('div');
    card.className = 'card owner-card';
    
    let isNew = !ownerData;
    let shareFrac = ownerData ? (ownerData.shareFrac || "") : "";
    let sharePerc = ownerData ? (ownerData.sharePerc || "") : "";
    const name = ownerData ? ownerData.name : "";
    const docInfo = ownerData ? ownerData.docInfo : "";
    const fileUrls = ownerData ? ownerData.fileUrls : "";

    let shareBarHtml = "";
    if (sharePerc && !isNaN(parseFloat(sharePerc))) {
        shareBarHtml = `<div class="share-bar-container"><div class="share-bar-fill" style="width: ${sharePerc}%;"></div></div>`;
    }

    let docLinksHtml = "";
    if (fileUrls && fileUrls.trim() !== "") {
        let links = fileUrls.split(",");
        docLinksHtml = `<div class="doc-links-container">`;
        links.forEach((url, i) => {
            if (url.trim() !== "") {
                docLinksHtml += `<a href="${url.trim()}" target="_blank" class="btn-doc-view"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>Документ ${i+1}</a>`;
            }
        });
        docLinksHtml += `</div>`;
    }

    card.innerHTML = `
        <div class="view-mode" style="display: ${isEditMode ? 'none' : 'block'};">
            <h3 class="card-title v-name" style="color: var(--apple-blue); font-size: 19px;">${name || 'Новий співвласник'}</h3>
            <div class="owner-data-row">
                <span class="owner-data-label">Частка власності</span>
                <span class="owner-data-value v-share">${shareFrac ? `${shareFrac} (${sharePerc}%)` : '—'}</span>
                ${shareBarHtml}
            </div>
            <div class="owner-data-row">
                <span class="owner-data-label">Дані документа</span>
                <span class="owner-data-value v-doc">${docInfo || '—'}</span>
                ${docLinksHtml}
            </div>
            <div class="action-group">
                <button class="btn btn-secondary edit-btn">Редагувати</button>
                <button class="btn btn-danger delete-btn">Видалити</button>
            </div>
        </div>
        <div class="edit-mode" style="display: ${isEditMode ? 'block' : 'none'};">
            <input type="hidden" class="h-existing-files" value="${fileUrls}">
            <h3 class="card-title">${name ? 'Редагування даних' : 'Новий співвласник'}</h3>
            <div class="form-group">
                <label>ПІБ співвласника</label>
                <input type="text" class="i-name" value="${name}" placeholder="Іванов Іван Іванович">
            </div>
            <div class="form-group">
                <label>Частка власності</label>
                <select class="i-share-preset">
                    <option value="">Оберіть зі списку...</option>
                    <option value="1/1|100" ${shareFrac === '1/1' ? 'selected' : ''}>1/1 (100%) - Одноосібна</option>
                    <option value="1/2|50" ${shareFrac === '1/2' ? 'selected' : ''}>1/2 (50%)</option>
                    <option value="1/3|33.33" ${shareFrac === '1/3' ? 'selected' : ''}>1/3 (33.33%)</option>
                    <option value="1/4|25" ${shareFrac === '1/4' ? 'selected' : ''}>1/4 (25%)</option>
                    <option value="2/3|66.67" ${shareFrac === '2/3' ? 'selected' : ''}>2/3 (66.67%)</option>
                    <option value="1/5|20" ${shareFrac === '1/5' ? 'selected' : ''}>1/5 (20%)</option>
                    <option value="custom" ${shareFrac && !['1/1','1/2','1/3','1/4','2/3','1/5'].includes(shareFrac) ? 'selected' : ''}>Інше (ввести вручну)...</option>
                </select>
                <input type="text" class="custom-share-input i-share-custom" style="display: ${shareFrac && !['1/1','1/2','1/3','1/4','2/3','1/5'].includes(shareFrac) ? 'block' : 'none'};" placeholder="Введіть дріб (1/6) або відсоток (15)" value="${shareFrac}">
            </div>
            <div class="form-group">
                <label>Дані документа</label>
                <input type="text" class="i-doc" value="${docInfo}" placeholder="Договір купівлі-продажу №123">
            </div>
            <div class="form-group">
                <label>Завантажити скан/фото</label>
                <input type="file" class="i-files" multiple accept="image/*,application/pdf" style="background: white; border: 1px dashed #ccc;">
            </div>
            <div class="action-group">
                <button class="btn btn-success save-ok-btn">Зберегти</button>
                <button class="btn btn-secondary cancel-btn">Скасувати</button>
            </div>
        </div>
    `;

    if (isNewAtTop) ownersContainer.prepend(card); else ownersContainer.appendChild(card);

    const presetSelect = card.querySelector('.i-share-preset');
    const customInput = card.querySelector('.i-share-custom');
    presetSelect.addEventListener('change', (e) => {
        if (e.target.value === 'custom') { customInput.style.display = 'block'; customInput.value = ''; } else { customInput.style.display = 'none'; }
    });

    card.querySelector('.edit-btn').addEventListener('click', () => {
        card.querySelector('.view-mode').style.display = 'none'; card.querySelector('.edit-mode').style.display = 'block';
    });
    card.querySelector('.cancel-btn').addEventListener('click', () => {
        if (isNew) card.remove(); else {
            card.querySelector('.edit-mode').style.display = 'none'; card.querySelector('.view-mode').style.display = 'block';
        }
    });
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
    menuPopup.style.display = 'none';
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
                
                html += `
                    <div style="border-bottom: 1px solid #F0F0F0; padding-bottom: 12px; margin-bottom: 12px;">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
                            <strong style="font-size: 15px; color: ${isRead ? 'var(--text-main)' : 'var(--apple-blue)'};">${msg.title}</strong>
                            <span style="font-size: 11px; color: #A1A1A6; white-space: nowrap;">${dateStr}</span>
                        </div>
                        <p style="margin: 0; font-size: 14px; color: var(--text-main); line-height: 1.4;">${msg.body}</p>
                    </div>`;
            }
        });

        list.innerHTML = count > 0 ? html : '<p style="font-size: 14px; color: var(--text-muted); text-align: center;">Немає нових повідомлень.</p>';
        badge.style.display = unreadMsgIds.length > 0 ? 'block' : 'none';

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

            html += `
                <div style="background: #F2F2F7; padding: 16px; border-radius: 14px;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
                        <strong style="font-size: 16px; color: var(--text-main);">${msg.title}</strong>
                        <span style="font-size: 11px; color: #A1A1A6;">${dateStr}</span>
                    </div>
                    <p style="font-size: 12px; color: var(--apple-blue); margin: 0 0 8px 0; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Кому: ${targetText}</p>
                    <p style="font-size: 14px; color: var(--text-main); margin: 0 0 12px 0; line-height: 1.4;">${msg.body}</p>
                    
                    <div style="border-top: 1px solid #E5E5EA; padding-top: 10px;">
                        <span style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; display: block; margin-bottom: 4px;">Прочитали:</span>
                        ${readHtml}
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch(e) {
        console.error("Помилка завантаження історії:", e);
        container.innerHTML = '<p style="color: var(--apple-red); font-size: 14px; text-align: center;">Помилка завантаження.</p>';
    }
}

// Прив'язуємо кнопку оновлення історії
document.getElementById('refreshHistoryBtn')?.addEventListener('click', loadAdminMessageHistory);

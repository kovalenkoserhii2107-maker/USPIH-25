// 1. ПІДКЛЮЧЕННЯ FIREBASE
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, collection, getDocs, addDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, updatePassword } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
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

// Елементи інтерфейсу
const loginSection = document.getElementById('loginSection');
const passwordSection = document.getElementById('passwordSection');
const dataSection = document.getElementById('dataSection');
const topNav = document.getElementById('topNav');
const ownersContainer = document.getElementById('ownersContainer');
const aptInput = document.getElementById('aptInput');
const passInput = document.getElementById('passInput');

// 2. АВТОРИЗАЦІЯ
document.getElementById('loginBtn').addEventListener('click', async () => {
    const apt = aptInput.value.trim();
    const pass = passInput.value;
    if (!apt || !pass) return showError("Заповніть усі поля!");

    const btn = document.getElementById('loginBtn');
    btn.innerText = "Перевірка..."; btn.disabled = true;
    document.getElementById('loginError').style.display = "none";

    // Секретна склейка: перетворюємо номер квартири на email
    const email = `${apt}@uspih-25.com`;

    try {
        await signInWithEmailAndPassword(auth, email, pass);
        await loadCabinetData(apt); // Завантажуємо дані з Firestore
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

// 3. ЗАВАНТАЖЕННЯ ДАНИХ З FIRESTORE
async function loadCabinetData(apt) {
    const aptRef = doc(db, "apartments", apt);
    const aptSnap = await getDoc(aptRef);
    
    let isFirstLogin = true;
    let areaVal = "";

    if (aptSnap.exists()) {
        const data = aptSnap.data();
        isFirstLogin = !data.passwordChanged; // Якщо пароль не міняли - значить перший вхід
        areaVal = data.area || "";
        
        // Повідомлення від адміністратора
        if (data.adminMessage) {
            document.getElementById('adminMessageText').innerText = data.adminMessage;
            document.getElementById('notifBadge').style.display = "block";
        }
    } else {
        // Якщо квартири ще немає в базі, створюємо її базовий профіль
        await setDoc(aptRef, { passwordChanged: false, area: "", lastLogin: new Date() });
    }

    // Відображення площі та номера
    document.getElementById('displayAptNum').innerText = apt;
    document.getElementById('aptArea').value = areaVal;
    document.getElementById('displayAreaVal').innerText = areaVal || "--";

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
        renderOwnerCard(null, 1, true); // Пуста картка
    }

    // Логіка екранів
    loginSection.style.display = "none";
    if (isFirstLogin) {
        document.getElementById('hiddenAptInput').value = apt;
        document.getElementById('cancelPassBtn').style.display = 'none';
        passwordSection.style.display = "block";
    } else {
        topNav.style.display = "block";
        dataSection.style.display = "block";
    }
}

// 4. ОНОВЛЕННЯ ДАНИХ ТА ЗАВАНТАЖЕННЯ ФАЙЛІВ У STORAGE
async function saveAllDataToFirebase() {
    const apt = document.getElementById('displayAptNum').innerText;
    if (!apt || apt === "--") throw new Error("Квартира не визначена");

    const ownerCards = document.querySelectorAll('.owner-card');
    const aptRef = doc(db, "apartments", apt);
    const ownersCollectionRef = collection(db, "apartments", apt, "owners");

    // 4.1. Зберігаємо площу
    let currentArea = document.getElementById('aptArea').value || document.getElementById('displayAreaVal').innerText.replace('--', '');
    await setDoc(aptRef, { area: currentArea, lastUpdate: new Date() }, { merge: true });

    // 4.2. Очищаємо старих власників, щоб записати нових без дублів
    const oldOwners = await getDocs(ownersCollectionRef);
    oldOwners.forEach(async (d) => { await deleteDoc(d.ref); });

    // 4.3. Обробляємо та зберігаємо нові картки
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

        // Збираємо старі файли
        let allFileUrls = [];
        if (existingFilesInput && existingFilesInput.value) {
            allFileUrls.push(...existingFilesInput.value.split(',').filter(u => u.trim() !== ''));
        }

        // Завантажуємо нові файли у Firebase Storage
        if (fileInput.files.length > 0) {
            for (let file of fileInput.files) {
                // Шлях у сховищі: apartments/45/16900000_doc.pdf
                const fileRef = sRef(storage, `apartments/${apt}/${Date.now()}_${file.name}`);
                await uploadBytes(fileRef, file);
                const url = await getDownloadURL(fileRef);
                allFileUrls.push(url);
            }
        }

        // Записуємо власника у Firestore
        await addDoc(ownersCollectionRef, {
            name: name,
            docInfo: card.querySelector('.i-doc').value,
            shareFrac: shareFrac,
            sharePerc: sharePerc,
            fileUrls: allFileUrls.join(',')
        });
    }
}

// 5. ЛОГІКА МЕНЮ, ДЗВІНОЧКА ТА ПЛОЩІ (Залишається як було)
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
document.getElementById('menuLogoutBtn').addEventListener('click', () => location.reload());

document.getElementById('editAreaBtn').addEventListener('click', () => {
    document.getElementById('areaViewMode').style.display = 'none';
    document.getElementById('areaEditMode').style.display = 'block';
});
document.getElementById('cancelAreaBtn').addEventListener('click', () => {
    document.getElementById('aptArea').value = document.getElementById('displayAreaVal').innerText.replace('--','');
    document.getElementById('areaEditMode').style.display = 'none';
    document.getElementById('areaViewMode').style.display = 'flex';
});
document.getElementById('saveAreaBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveAreaBtn');
    btn.innerText = "⏳..."; btn.disabled = true;
    
    try {
        const apt = document.getElementById('displayAptNum').innerText;
        const newArea = document.getElementById('aptArea').value;
        
        // Зберігаємо ТІЛЬКИ площу напряму в базу (не чіпаючи власників)
        const aptRef = doc(db, "apartments", apt);
        await setDoc(aptRef, { area: newArea, lastUpdate: new Date() }, { merge: true });
        
        // Оновлюємо інтерфейс
        document.getElementById('displayAreaVal').innerText = newArea || "--";
        document.getElementById('areaEditMode').style.display = 'none';
        document.getElementById('areaViewMode').style.display = 'flex';
        
    } catch(e) {
        console.error(e);
        alert("Помилка збереження площі.");
    } finally {
        btn.innerText = "Зберегти"; btn.disabled = false;
    }
});

// 6. МАЛЮВАННЯ КАРТОК (Функції calculateShares та renderOwnerCard)
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
                <label>Завантажити скан/фото (додасться до існуючих)</label>
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
            await loadCabinetData(document.getElementById('displayAptNum').innerText); // Тихе перемальовування
        } catch (error) {
            alert("Помилка збереження. Перевірте інтернет.");
            btn.innerText = "Зберегти"; btn.disabled = false;
        } 
    });
}

// 7. РОБОТА З ПАРОЛЕМ (ОКО ТА ЗМІНА)
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
        
        // Відмічаємо в базі, що пароль змінено
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

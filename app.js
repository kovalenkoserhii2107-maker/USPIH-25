// URL вашего будущего веб-приложения Google (заполним позже)
const GOOGLE_APP_URL = "https://script.google.com/macros/s/AKfycbxff531zYaHcDTiI8W6XR16VjkFp96sAfqqUVl7NzqH1V1pno-Z6t3KlngcZqicOeIVsA/exec";

const loginSection = document.getElementById('loginSection');
const passwordSection = document.getElementById('passwordSection');
const dataSection = document.getElementById('dataSection');
const topNav = document.getElementById('topNav');
const ownersContainer = document.getElementById('ownersContainer');
const aptInput = document.getElementById('aptInput');
const passInput = document.getElementById('passInput');

// 1. АВТОРИЗАЦІЯ ТА ПОВІДОМЛЕННЯ
document.getElementById('loginBtn').addEventListener('click', () => {
    const apt = aptInput.value;
    const pass = passInput.value;
    if (!apt || !pass) return showError("Заповніть усі поля!");

    const btn = document.getElementById('loginBtn');
    btn.innerText = "Перевірка..."; btn.disabled = true;
    document.getElementById('loginError').style.display = "none";

    fetch(GOOGLE_APP_URL, {
        method: 'POST',
        body: JSON.stringify({ action: "login", aptNumber: apt, password: pass })
    }).then(res => res.json()).then(data => {
        if (data.status === "success") {
            // Відображення площі
            const areaVal = data.area || "";
            document.getElementById('aptArea').value = areaVal;
            document.getElementById('displayAreaVal').innerText = areaVal || "--";
            // Відображення площі та квартири
            document.getElementById('displayAptNum').innerText = apt; // <--- ДОДАТИ ЦЕ

            // Обробка повідомлень від адміністратора
            if (data.adminMessage && data.adminMessage.trim() !== "") {
                document.getElementById('adminMessageText').innerText = data.adminMessage;
                document.getElementById('notifBadge').style.display = "block"; // Червона крапка
            } else {
                document.getElementById('adminMessageText').innerText = "Немає нових повідомлень від правління ОСББ.";
                document.getElementById('notifBadge').style.display = "none";
            }

            ownersContainer.innerHTML = ""; 
            if (data.owners && data.owners.length > 0) {
                data.owners.forEach((o, index) => renderOwnerCard(o, index + 1, false));
            } else {
                renderOwnerCard(null, 1, true);
            }
            
            loginSection.style.display = "none";
            
            if (data.isFirstLogin) {
                passwordSection.style.display = "block";
            } else {
                topNav.style.display = "block"; // Показуємо шапку тільки в кабінеті
                dataSection.style.display = "block";
            }
        } else {
            showError(data.message);
        }
    }).catch(()=> showError("Помилка з'єднання.")).finally(() => {
        btn.innerText = "Увійти"; btn.disabled = false;
    });
});

function showError(msg) {
    const err = document.getElementById('loginError');
    err.innerText = msg; err.style.display = "block";
}

// ЛОГІКА ДЗВІНОЧКА (Колокольчик)
const bellBtn = document.getElementById('bellBtn');
const notifPopup = document.getElementById('notifPopup');
bellBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    notifPopup.style.display = notifPopup.style.display === 'none' ? 'block' : 'none';
    document.getElementById('notifBadge').style.display = 'none'; // Ховаємо червону крапку після прочитання
});
// Закрити попап при кліку в іншому місці
document.addEventListener('click', (e) => {
    if (!notifPopup.contains(e.target) && !bellBtn.contains(e.target)) {
        notifPopup.style.display = 'none';
    }
});

// 2. ЛОГІКА ПЛОЩІ 
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
        await saveAllDataToGoogle();
        await refreshDataSilent();
        document.getElementById('displayAreaVal').innerText = document.getElementById('aptArea').value || "--";
        document.getElementById('areaEditMode').style.display = 'none';
        document.getElementById('areaViewMode').style.display = 'flex';
    } catch(e) {
        alert("Помилка збереження площі.");
    } finally {
        btn.innerText = "Зберегти"; btn.disabled = false;
    }
});

// 3. МАЛЮВАННЯ КАРТОК ВЛАСНИКІВ
document.getElementById('addOwnerBtn').addEventListener('click', () => {
    renderOwnerCard(null, ownersContainer.children.length + 1, true, true);
});

function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function calculateShares(val) {
    val = val.replace(',', '.');
    if (val.includes('/') || val.includes('\\')) {
        let frac = val.replace('\\', '/');
        let parts = frac.split('/');
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            let p = ((parseFloat(parts[0]) / parseFloat(parts[1])) * 100).toFixed(2);
            return { frac: frac, perc: p.replace('.00', '') };
        }
    } else if (!isNaN(parseFloat(val))) {
        let perc = parseFloat(val);
        let num = Math.round(perc * 100);
        let den = 10000;
        let div = gcd(num, den);
        return { frac: `${num/div}/${den/div}`, perc: perc.toString() };
    }
    return { frac: val, perc: val };
}

// Зверніть увагу на новий аргумент "isNewAtTop"
function renderOwnerCard(ownerData, number, isEditMode, isNewAtTop = false) {
    const card = document.createElement('div');
    card.className = 'card owner-card';
    
    let isNew = !ownerData;
    let shareFrac = ownerData ? String(ownerData.shareFrac) : "";
    let sharePerc = ownerData ? String(ownerData.sharePerc) : "";

    // Захист від дат
    if (shareFrac.includes('GMT') || shareFrac.includes('Time') || shareFrac.includes('2026')) {
        shareFrac = ""; sharePerc = "";
    }
    if (shareFrac.startsWith("'")) shareFrac = shareFrac.substring(1);

    const name = ownerData ? ownerData.name : "";
    const docInfo = ownerData ? ownerData.docInfo : "";
    const fileUrls = ownerData ? ownerData.fileUrls : "";

    // 1. Формуємо HTML для бару частки (Progress Bar)
    let shareBarHtml = "";
    if (sharePerc && !isNaN(parseFloat(sharePerc))) {
        shareBarHtml = `
        <div class="share-bar-container">
            <div class="share-bar-fill" style="width: ${sharePerc}%;"></div>
        </div>`;
    }

    // 2. Формуємо HTML для кнопок документів
    let docLinksHtml = "";
    if (fileUrls && fileUrls.trim() !== "") {
        let links = fileUrls.split(", ");
        docLinksHtml = `<div class="doc-links-container">`;
        links.forEach((url, i) => {
            if (url.trim() !== "") {
                docLinksHtml += `
                <a href="${url.trim()}" target="_blank" class="btn-doc-view">
                    <svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                    Документ ${i+1}
                </a>`;
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
                ${shareBarHtml} <!-- Наш новий бар -->
            </div>
            
            <div class="owner-data-row">
                <span class="owner-data-label">Дані документа</span>
                <span class="owner-data-value v-doc">${docInfo || '—'}</span>
                ${docLinksHtml} <!-- Наші нові кнопки -->
            </div>
            
            <div class="action-group">
                <button class="btn btn-secondary edit-btn">Редагувати</button>
                <button class="btn btn-danger delete-btn">Видалити</button>
            </div>
        </div>

        <div class="edit-mode" style="display: ${isEditMode ? 'block' : 'none'};">
            <!-- ОСЬ ЦЕЙ РЯДОК ЗБЕРІГАЄ СТАРІ ДОКУМЕНТИ -->
            <input type="hidden" class="h-existing-files" value="${fileUrls}">
            
            <h3 class="card-title">${name ? 'Редагування даних' : 'Новий співвласник'}</h3>
            <div class="form-group">
                <label>ПІБ співвласника</label>
                
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
                <label>Завантажити скан/фото (замінить старі)</label>
                <input type="file" class="i-files" multiple accept="image/*,application/pdf" style="background: white; border: 1px dashed #ccc;">
            </div>
            <div class="action-group">
                <button class="btn btn-success save-ok-btn">Зберегти</button>
                <button class="btn btn-secondary cancel-btn">Скасувати</button>
            </div>
        </div>
    `;

    // 3. Вставляємо картку: якщо це нова картка з кнопки, то НАГОРУ (prepend), інакше - вниз (append)
    if (isNewAtTop) {
        ownersContainer.prepend(card);
    } else {
        ownersContainer.appendChild(card);
    }

    // --- Далі йде ВАШ СТАРИЙ КОД логіки кнопок всередині картки (presetSelect, edit-btn, save-ok-btn тощо) ---
    // (Не видаляйте його, він залишається без змін)
    
    const presetSelect = card.querySelector('.i-share-preset');
    const customInput = card.querySelector('.i-share-custom');
    presetSelect.addEventListener('change', (e) => {
        if (e.target.value === 'custom') {
            customInput.style.display = 'block'; customInput.value = '';
        } else { customInput.style.display = 'none'; }
    });

    card.querySelector('.edit-btn').addEventListener('click', () => {
        card.querySelector('.view-mode').style.display = 'none';
        card.querySelector('.edit-mode').style.display = 'block';
    });

    card.querySelector('.cancel-btn').addEventListener('click', () => {
        if (isNew) card.remove();
        else {
            card.querySelector('.i-name').value = card.querySelector('.v-name').innerText;
            card.querySelector('.i-doc').value = card.querySelector('.v-doc').innerText;
            card.querySelector('.edit-mode').style.display = 'none';
            card.querySelector('.view-mode').style.display = 'block';
        }
    });

    card.querySelector('.delete-btn').addEventListener('click', async () => {
        if (confirm("Точно видалити цього співвласника з реєстру?")) {
            card.remove();
            try { await saveAllDataToGoogle(); } catch(e) { alert("Помилка при видаленні з бази."); }
        }
    });

    card.querySelector('.save-ok-btn').addEventListener('click', async function() {
        const btn = this;
        btn.innerText = "⏳..."; btn.disabled = true;

        try {
            await saveAllDataToGoogle(); 
            await refreshDataSilent(); // <--- ТИХЕ ОНОВЛЕННЯ ЗАМІСТЬ RELOAD
            alert("Дані успішно збережено!");
        } catch (error) {
            alert("Помилка збереження. Перевірте інтернет.");
            btn.innerText = "Зберегти"; btn.disabled = false;
        } 
    });
}

// 4. ФУНКЦІЯ ПІДГОТОВКИ ТА ВІДПРАВКИ
async function saveAllDataToGoogle() {
    const ownerCards = document.querySelectorAll('.owner-card');
    const ownersData = [];

    for (let card of ownerCards) {
        const name = card.querySelector('.i-name').value;
        if (!name) continue; 
        
        const presetSelect = card.querySelector('.i-share-preset').value;
        const customInput = card.querySelector('.i-share-custom').value;
        const fileInput = card.querySelector('.i-files');
        
        // Зчитуємо старі файли з прихованого поля
        const existingFilesInput = card.querySelector('.h-existing-files');
        const existingFiles = existingFilesInput ? existingFilesInput.value : "";
        
        let shareFrac = "", sharePerc = "";
        if (presetSelect === 'custom') {
            const calc = calculateShares(customInput);
            shareFrac = calc.frac; sharePerc = calc.perc;
        } else if (presetSelect) {
            const parts = presetSelect.split('|');
            shareFrac = parts[0]; sharePerc = parts[1];
        }

        const filesData = [];
        if (fileInput.files.length > 0) {
            for (let file of fileInput.files) {
                const base64 = await readFileAsBase64(file);
                filesData.push({ mimeType: file.type, base64: base64 });
            }
        }

        ownersData.push({ 
            name: name, 
            docInfo: card.querySelector('.i-doc').value, 
            shareFrac: shareFrac, 
            sharePerc: sharePerc, 
            existingFiles: existingFiles, // <--- ПЕРЕДАЄМО СТАРІ ФАЙЛИ НА СЕРВЕР
            files: filesData 
        });
    }

    let currentArea = document.getElementById('aptArea').value;
    if (!currentArea || currentArea.trim() === "") {
        currentArea = document.getElementById('displayAreaVal').innerText.replace('--', '').trim();
    }

    const payload = { action: "update", aptNumber: aptInput.value, area: currentArea, owners: ownersData };
    const res = await fetch(GOOGLE_APP_URL, { method: 'POST', body: JSON.stringify(payload) });
    const data = await res.json();
    if (data.status !== "success") throw new Error(data.message);
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = error => reject(error);
        reader.readAsDataURL(file);
    });
}

// 5. ЗМІНА ПАРОЛЯ ТА ВИХІД
document.getElementById('savePassBtn').addEventListener('click', () => {
    const newPass = document.getElementById('newPass').value;
    const confirmPass = document.getElementById('confirmPass').value;
    const passErr = document.getElementById('passError');
    if (newPass !== confirmPass || newPass.length < 4) {
        passErr.innerText = "Паролі не співпадають або коротші 4 символів"; passErr.style.display = "block"; return;
    }

    const btn = document.getElementById('savePassBtn');
    btn.innerText = "⏳..."; btn.disabled = true;

    fetch(GOOGLE_APP_URL, {
        method: 'POST',
        body: JSON.stringify({ action: "changePassword", aptNumber: aptInput.value, oldPassword: passInput.value, newPassword: newPass })
    }).then(res => res.json()).then(data => {
        if (data.status === "success") {
            passInput.value = newPass;
            passwordSection.style.display = "none";
            topNav.style.display = "block";
            dataSection.style.display = "block";
        } else {
            passErr.innerText = data.message; passErr.style.display = "block";
        }
    }).finally(() => { btn.innerText = "Зберегти пароль"; btn.disabled = false; });
});

// ФУНКЦІЯ ТИХОГО ОНОВЛЕННЯ ДАНИХ (БЕЗ ПЕРЕЗАВАНТАЖЕННЯ СТОРІНКИ)
async function refreshDataSilent() {
    const apt = aptInput.value;
    const pass = passInput.value;
    if (!apt || !pass) return;

    try {
        const res = await fetch(GOOGLE_APP_URL, {
            method: 'POST',
            body: JSON.stringify({ action: "login", aptNumber: apt, password: pass })
        });
        const data = await res.json();
        
        if (data.status === "success") {
            const areaVal = data.area || "";
            document.getElementById('aptArea').value = areaVal;
            document.getElementById('displayAreaVal').innerText = areaVal || "--";

            ownersContainer.innerHTML = ""; 
            if (data.owners && data.owners.length > 0) {
                data.owners.forEach((o, index) => renderOwnerCard(o, index + 1, false));
            } else {
                renderOwnerCard(null, 1, true);
            }
        }
    } catch (e) {
        console.error("Помилка фонового оновлення", e);
    }
}

document.getElementById('logoutBtn').addEventListener('click', () => location.reload());

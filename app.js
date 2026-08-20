// URL вашего будущего веб-приложения Google (заполним позже)
const GOOGLE_APP_URL = "https://script.google.com/macros/s/AKfycbyEsia0QDjhq3BmPGe7NQ1yuYYQJgM90EdJ1ZX1cO1jApuja6nuM3TnVOOANjD6CzXY5w/exec";

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
    renderOwnerCard(null, ownersContainer.children.length + 1, true);
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

function renderOwnerCard(ownerData, number, isEditMode) {
    const card = document.createElement('div');
    card.className = 'card owner-card';
    
    let isNew = !ownerData;
    let shareFrac = ownerData ? ownerData.shareFrac : "";
    let sharePerc = ownerData ? ownerData.sharePerc : "";

    const name = ownerData ? ownerData.name : "";
    const docInfo = ownerData ? ownerData.docInfo : "";

    card.innerHTML = `
        <div class="view-mode" style="display: ${isEditMode ? 'none' : 'block'};">
            <h3 class="card-title v-name" style="color: var(--apple-blue); font-size: 19px;">${name || 'Новий співвласник'}</h3>
            <div class="owner-data-row">
                <span class="owner-data-label">Частка власності</span>
                <span class="owner-data-value v-share">${shareFrac ? `${shareFrac} (${sharePerc}%)` : '—'}</span>
            </div>
            <div class="owner-data-row">
                <span class="owner-data-label">Дані документа</span>
                <span class="owner-data-value v-doc">${docInfo || '—'}</span>
            </div>
            <div class="action-group">
                <button class="btn btn-secondary edit-btn">Редагувати</button>
                <button class="btn btn-danger delete-btn">Видалити</button>
            </div>
        </div>

        <div class="edit-mode" style="display: ${isEditMode ? 'block' : 'none'};">
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

    ownersContainer.appendChild(card);

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
            isNew = false;
            
            const newName = card.querySelector('.i-name').value;
            let finalFrac = "", finalPerc = "";
            if (presetSelect.value === 'custom') {
                const calc = calculateShares(customInput.value);
                finalFrac = calc.frac; finalPerc = calc.perc;
            } else if (presetSelect.value) {
                const parts = presetSelect.value.split('|');
                finalFrac = parts[0]; finalPerc = parts[1];
            }

            card.querySelector('.v-name').innerText = newName || 'Не вказано';
            card.querySelector('.v-doc').innerText = card.querySelector('.i-doc').value || '—';
            card.querySelector('.v-share').innerText = finalFrac ? `${finalFrac} (${finalPerc}%)` : '—';
            
            card.querySelector('.edit-mode').style.display = 'none';
            card.querySelector('.view-mode').style.display = 'block';
        } catch (error) {
            alert("Помилка збереження. Перевірте інтернет.");
        } finally {
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

        ownersData.push({ name: name, docInfo: card.querySelector('.i-doc').value, shareFrac: shareFrac, sharePerc: sharePerc, files: filesData });
    }

    const payload = { action: "update", aptNumber: aptInput.value, area: document.getElementById('aptArea').value, owners: ownersData };
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

document.getElementById('logoutBtn').addEventListener('click', () => location.reload());

// URL вашего будущего веб-приложения Google (заполним позже)
const GOOGLE_APP_URL = "https://script.google.com/macros/s/AKfycbwBJpPFMijKanBQ0hNuB6-GlKsC06I-ep5bv85jT8kXeMzANfnSK8PlgFBVj6qblfQGoA/exec";

const loginSection = document.getElementById('loginSection');
const passwordSection = document.getElementById('passwordSection');
const dataSection = document.getElementById('dataSection');
const ownersContainer = document.getElementById('ownersContainer');
const aptInput = document.getElementById('aptInput');
const passInput = document.getElementById('passInput');
const aptArea = document.getElementById('aptArea');

// 1. АВТОРИЗАЦІЯ
document.getElementById('loginBtn').addEventListener('click', () => {
    const apt = aptInput.value;
    const pass = passInput.value;
    if (!apt || !pass) return alert("Заповніть усі поля!");

    const btn = document.getElementById('loginBtn');
    btn.innerText = "Перевірка..."; btn.disabled = true;

    fetch(GOOGLE_APP_URL, {
        method: 'POST',
        body: JSON.stringify({ action: "login", aptNumber: apt, password: pass })
    }).then(res => res.json()).then(data => {
        if (data.status === "success") {
            aptArea.value = data.area || "";
            ownersContainer.innerHTML = ""; 
            
            if (data.owners && data.owners.length > 0) {
                // Малюємо карточки в режимі ПЕРЕГЛЯДУ (Read-only)
                data.owners.forEach((o, index) => renderOwnerCard(o, index + 1, false));
            } else {
                // Якщо пусто, малюємо одну в режимі РЕДАГУВАННЯ
                renderOwnerCard(null, 1, true);
            }
            
            loginSection.style.display = "none";
            if (data.isFirstLogin) passwordSection.style.display = "block";
            else dataSection.style.display = "block";
        } else {
            alert(data.message);
        }
    }).finally(() => {
        btn.innerText = "Увійти"; btn.disabled = false;
    });
});

document.getElementById('addOwnerBtn').addEventListener('click', () => {
    renderOwnerCard(null, ownersContainer.children.length + 1, true);
});

// Допоміжна математика для розрахунку часток
function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function calculateShares(val) {
    val = val.replace(',', '.'); // Захист від коми
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
    return { frac: val, perc: val }; // Якщо ввели текст
}

// ГОЛОВНА ЛОГІКА КАРТОЧОК ВЛАСНИКІВ
function renderOwnerCard(ownerData, number, isEditMode) {
    const card = document.createElement('div');
    card.className = 'owner-card';
    
    // Дефолтні значення
    const name = ownerData ? ownerData.name : "";
    const docInfo = ownerData ? ownerData.docInfo : "";
    const shareFrac = ownerData ? ownerData.shareFrac : "";
    const sharePerc = ownerData ? ownerData.sharePerc : "";

    card.innerHTML = `
        <div class="card-header">Співвласник ${number}</div>
        
        <!-- РЕЖИМ ПЕРЕГЛЯДУ -->
        <div class="view-mode" style="display: ${isEditMode ? 'none' : 'block'};">
            <p><strong>ПІБ:</strong> <span class="v-name">${name || 'Не вказано'}</span></p>
            <p><strong>Частка:</strong> <span class="v-share">${shareFrac ? `${shareFrac} (${sharePerc}%)` : 'Не вказано'}</span></p>
            <p><strong>Документ:</strong> <span class="v-doc">${docInfo || 'Не вказано'}</span></p>
            <button class="btn-small edit-btn" style="margin-top: 10px;">✎ Редагувати</button>
        </div>

        <!-- РЕЖИМ РЕДАГУВАННЯ -->
        <div class="edit-mode" style="display: ${isEditMode ? 'block' : 'none'};">
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
                <input type="text" class="i-share-custom" style="display: none; margin-top: 5px;" placeholder="Введіть дріб (1/6) або відсоток (15)" value="${shareFrac}">
            </div>

            <div class="form-group">
                <label>Дані документа (Тип, Серія, Номер, Дата)</label>
                <input type="text" class="i-doc" value="${docInfo}" placeholder="Договір купівлі-продажу №123 від 01.01.2020">
            </div>
            
            <div class="form-group">
                <label>Завантажити скан/фото (можна декілька)</label>
                <input type="file" class="i-files" multiple accept="image/*,application/pdf">
            </div>

            <div class="flex-buttons">
                <button class="btn-small btn-success save-ok-btn">✅ ОК (Зберегти)</button>
                <button class="btn-small btn-danger clear-btn">❌ Видалити/Очистити</button>
            </div>
        </div>
    `;

    ownersContainer.appendChild(card);

    // Логіка випадаючого списку часток
    const presetSelect = card.querySelector('.i-share-preset');
    const customInput = card.querySelector('.i-share-custom');
    
    // Показуємо поле ручного вводу, якщо при завантаженні вибрано "custom"
    if (presetSelect.value === "custom") customInput.style.display = "block";

    presetSelect.addEventListener('change', (e) => {
        if (e.target.value === 'custom') {
            customInput.style.display = 'block';
            customInput.value = '';
        } else {
            customInput.style.display = 'none';
        }
    });

    // Кнопка Редагувати
    card.querySelector('.edit-btn').addEventListener('click', () => {
        card.querySelector('.view-mode').style.display = 'none';
        card.querySelector('.edit-mode').style.display = 'block';
    });

    // Кнопка Видалити/Очистити
    card.querySelector('.clear-btn').addEventListener('click', () => {
        if (confirm("Точно видалити запис про цього власника?")) {
            card.remove();
        }
    });

    // Кнопка ОК (Зберегти)
    card.querySelector('.save-ok-btn').addEventListener('click', async function() {
        const btn = this;
        btn.innerText = "⏳ Збереження..."; btn.disabled = true;

        try {
            await saveAllDataToGoogle(); // Зберігаємо ВСЮ сторінку, щоб уникнути конфліктів бази
            
            // Оновлюємо візуальну частину карточки
            const newName = card.querySelector('.i-name').value;
            const newDoc = card.querySelector('.i-doc').value;
            let finalFrac = "", finalPerc = "";
            
            if (presetSelect.value === 'custom') {
                const calc = calculateShares(customInput.value);
                finalFrac = calc.frac; finalPerc = calc.perc;
            } else if (presetSelect.value) {
                const parts = presetSelect.value.split('|');
                finalFrac = parts[0]; finalPerc = parts[1];
            }

            card.querySelector('.v-name').innerText = newName;
            card.querySelector('.v-doc').innerText = newDoc;
            card.querySelector('.v-share').innerText = `${finalFrac} (${finalPerc}%)`;
            
            // Перемикаємо вигляд
            card.querySelector('.edit-mode').style.display = 'none';
            card.querySelector('.view-mode').style.display = 'block';
            alert("Дані успішно оновлені в таблиці!");
        } catch (error) {
            alert("Помилка збереження. Спробуйте ще раз.");
        } finally {
            btn.innerText = "✅ ОК (Зберегти)"; btn.disabled = false;
        }
    });
}

// ФУНКЦІЯ ПІДГОТОВКИ ТА ВІДПРАВКИ ДАНИХ
async function saveAllDataToGoogle() {
    const ownerCards = document.querySelectorAll('.owner-card');
    const ownersData = [];

    for (let card of ownerCards) {
        // Збираємо дані тільки з тих карток, де ввели хоч якесь ПІБ
        const name = card.querySelector('.i-name').value;
        if (!name) continue; 
        
        const docInfo = card.querySelector('.i-doc').value;
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

        ownersData.push({
            name: name,
            docInfo: docInfo,
            shareFrac: shareFrac,
            sharePerc: sharePerc,
            files: filesData
        });
    }

    const payload = {
        action: "update",
        aptNumber: aptInput.value,
        area: aptArea.value,
        owners: ownersData
    };

    const res = await fetch(GOOGLE_APP_URL, {
        method: 'POST',
        body: JSON.stringify(payload)
    });
    
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

// Зміна пароля та Вихід залишаються як були
document.getElementById('savePassBtn').addEventListener('click', () => {
    // ... ваш старий код для пароля ...
});

document.getElementById('logoutBtn').addEventListener('click', () => location.reload());

document.getElementById('logoutBtn').addEventListener('click', () => {
    location.reload(); // Найпростіший спосіб скинути всі стани при виході
});

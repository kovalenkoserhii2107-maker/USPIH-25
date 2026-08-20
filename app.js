// URL вашего будущего веб-приложения Google (заполним позже)
const GOOGLE_APP_URL = "https://script.google.com/macros/s/AKfycbyqyb3N-FrKtw5fA1lCbmsWPgCfPsA11H7bbnJecItf2QzMIsyNvTS4hr58_-dqFBa8Sw/exec";

const loginSection = document.getElementById('loginSection');
const passwordSection = document.getElementById('passwordSection');
const dataSection = document.getElementById('dataSection');
const ownersContainer = document.getElementById('ownersContainer');

const aptInput = document.getElementById('aptInput');
const passInput = document.getElementById('passInput');
const aptArea = document.getElementById('aptArea');

let ownerCount = 0; // Лічильник карток власників

// 1. АВТОРИЗАЦІЯ
document.getElementById('loginBtn').addEventListener('click', () => {
    const apt = aptInput.value;
    const pass = passInput.value;
    if (!apt || !pass) return alert("Заповніть усі поля!");

    const btn = document.getElementById('loginBtn');
    btn.innerText = "Перевірка...";
    btn.disabled = true;

    fetch(GOOGLE_APP_URL, {
        method: 'POST',
        body: JSON.stringify({ action: "login", aptNumber: apt, password: pass })
    }).then(res => res.json()).then(data => {
        if (data.status === "success") {
            aptArea.value = data.area || "";
            ownersContainer.innerHTML = ""; // Очищаємо контейнер
            ownerCount = 0;
            
            // Якщо є вже збережені власники, рендеримо їх
            if (data.owners && data.owners.length > 0) {
                data.owners.forEach(o => addOwnerBlock(o.name, o.share));
            } else {
                addOwnerBlock(); // Додаємо один порожній блок за замовчуванням
            }
            
            loginSection.style.display = "none";
            if (data.isFirstLogin) passwordSection.style.display = "block";
            else dataSection.style.display = "block";
        } else {
            alert(data.message);
        }
    }).finally(() => {
        btn.innerText = "Увійти";
        btn.disabled = false;
    });
});

// 2. ДИНАМІЧНЕ ДОДАВАННЯ ВЛАСНИКІВ
document.getElementById('addOwnerBtn').addEventListener('click', () => addOwnerBlock());

function addOwnerBlock(name = "", share = "") {
    ownerCount++;
    const block = document.createElement('div');
    block.className = 'owner-block';
    block.style.cssText = "background: #f9f9f9; padding: 15px; border-radius: 8px; margin-bottom: 15px; border: 1px solid #eee;";
    block.innerHTML = `
        <h4 style="margin-top: 0;">Співвласник ${ownerCount}</h4>
        <div class="form-group">
            <label>ПІБ співвласника</label>
            <input type="text" class="owner-name" value="${name}" placeholder="Іванов Іван Іванович">
        </div>
        <div class="form-group">
            <label>Частка власності (наприклад: 1/1, 1/2, 25%)</label>
            <input type="text" class="owner-share" value="${share}" placeholder="1/2">
        </div>
        <div class="form-group">
            <label>Документи (можна обрати декілька)</label>
            <input type="file" class="owner-docs" multiple accept="image/*,application/pdf">
        </div>
        <button class="remove-owner-btn btn-secondary" style="background: #e74c3c; padding: 8px;">Видалити</button>
    `;
    
    // Видалення блоку
    block.querySelector('.remove-owner-btn').addEventListener('click', function() {
        block.remove();
    });
    
    ownersContainer.appendChild(block);
}

// 3. ЗМІНА ПАРОЛЯ (Код залишився без змін, просто викликаємо fetch)
document.getElementById('savePassBtn').addEventListener('click', () => {
    const newPass = document.getElementById('newPass').value;
    const confirmPass = document.getElementById('confirmPass').value;
    if (newPass !== confirmPass || newPass.length < 4) return alert("Паролі не співпадають або занадто короткі!");

    fetch(GOOGLE_APP_URL, {
        method: 'POST',
        body: JSON.stringify({ action: "changePassword", aptNumber: aptInput.value, oldPassword: passInput.value, newPassword: newPass })
    }).then(res => res.json()).then(data => {
        if (data.status === "success") {
            passInput.value = newPass;
            passwordSection.style.display = "none";
            dataSection.style.display = "block";
            alert("Пароль успішно змінено!");
        } else alert(data.message);
    });
});

// 4. ЗБЕРЕЖЕННЯ ДАНИХ (Складна частина з файлами)
document.getElementById('saveBtn').addEventListener('click', async () => {
    const saveBtn = document.getElementById('saveBtn');
    saveBtn.innerText = "Обробка файлів та відправка...";
    saveBtn.disabled = true;

    try {
        const ownerBlocks = document.querySelectorAll('.owner-block');
        const ownersData = [];

        // Проходимо по всіх створених картках власників
        for (let block of ownerBlocks) {
            const name = block.querySelector('.owner-name').value;
            const share = block.querySelector('.owner-share').value;
            const fileInput = block.querySelector('.owner-docs');
            const filesData = [];

            // Якщо вибрані файли, читаємо їх усі через Promise
            if (fileInput.files.length > 0) {
                for (let file of fileInput.files) {
                    const base64 = await readFileAsBase64(file);
                    filesData.push({ mimeType: file.type, base64: base64 });
                }
            }

            ownersData.push({ name: name, share: share, files: filesData });
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

        if (data.status === "success") alert("Дані та документи успішно збережено!");
        else alert("Помилка: " + data.message);

    } catch (err) {
        console.error(err);
        alert("Сталася помилка при обробці файлів або відправці.");
    } finally {
        saveBtn.innerText = "Зберегти всі дані";
        saveBtn.disabled = false;
    }
});

// Допоміжна функція для читання файлів
function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = error => reject(error);
        reader.readAsDataURL(file);
    });
}

document.getElementById('logoutBtn').addEventListener('click', () => {
    location.reload(); // Найпростіший спосіб скинути всі стани при виході
});

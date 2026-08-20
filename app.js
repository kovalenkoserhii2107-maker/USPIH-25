// URL вашего будущего веб-приложения Google (заполним позже)
const GOOGLE_APP_URL = "https://script.google.com/macros/s/AKfycby3OnOg_ViFSzE0OvgWoAkxp4-srKcGgB5wo-WGkU3MgQRq1iOuTXotaeeSAY7PzHFRvw/exec";

// Элементы интерфейса
const loginSection = document.getElementById('loginSection');
const passwordSection = document.getElementById('passwordSection');
const dataSection = document.getElementById('dataSection');

const aptInput = document.getElementById('aptInput');
const passInput = document.getElementById('passInput');
const loginError = document.getElementById('loginError');

const newPassInput = document.getElementById('newPass');
const confirmPassInput = document.getElementById('confirmPass');
const passError = document.getElementById('passError');
const savePassBtn = document.getElementById('savePassBtn');

const ownerName = document.getElementById('ownerName');
const aptArea = document.getElementById('aptArea');
const docUpload = document.getElementById('docUpload');
const loginBtn = document.getElementById('loginBtn');
const saveBtn = document.getElementById('saveBtn');

// 1. Кнопка Входа
loginBtn.addEventListener('click', () => {
    const apt = aptInput.value;
    const pass = passInput.value;

    if (!apt || !pass) {
        showError("Заповніть усі поля!");
        return;
    }

    loginError.style.display = "none";
    loginBtn.innerText = "Перевірка...";
    loginBtn.disabled = true;

    fetch(GOOGLE_APP_URL, {
        method: 'POST',
        body: JSON.stringify({ action: "login", aptNumber: apt, password: pass })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === "success") {
            ownerName.value = data.ownerName || "";
            aptArea.value = data.area || "";
            
            loginSection.style.display = "none";
            
            // Проверяем, первый ли это вход
            if (data.isFirstLogin) {
                passwordSection.style.display = "block";
            } else {
                dataSection.style.display = "block";
            }
        } else {
            showError(data.message || "Помилка входу");
        }
    })
    .catch(err => {
        showError("Помилка зв'язку з сервером.");
        console.error(err);
    })
    .finally(() => {
        loginBtn.innerText = "Увійти";
        loginBtn.disabled = false;
    });
});

// 2. Кнопка Сохранения нового пароля
savePassBtn.addEventListener('click', () => {
    const newPass = newPassInput.value;
    const confirmPass = confirmPassInput.value;

    if (!newPass || !confirmPass) {
        showPassError("Заповніть усі поля!");
        return;
    }
    if (newPass !== confirmPass) {
        showPassError("Паролі не співпадають!");
        return;
    }
    if (newPass.length < 4) {
        showPassError("Пароль має бути не менше 4 символів!");
        return;
    }

    passError.style.display = "none";
    savePassBtn.innerText = "Збереження...";
    savePassBtn.disabled = true;

    fetch(GOOGLE_APP_URL, {
        method: 'POST',
        body: JSON.stringify({ 
            action: "changePassword", 
            aptNumber: aptInput.value, 
            oldPassword: passInput.value,
            newPassword: newPass
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === "success") {
            passInput.value = newPass; // Обновляем пароль в памяти фронтенда
            passwordSection.style.display = "none";
            dataSection.style.display = "block";
            alert("Пароль успішно змінено!");
        } else {
            showPassError(data.message || "Помилка зміни пароля");
        }
    })
    .catch(err => {
        showPassError("Помилка зв'язку з сервером.");
    })
    .finally(() => {
        savePassBtn.innerText = "Зберегти пароль";
        savePassBtn.disabled = false;
    });
});

// 3. Кнопка Сохранения данных и файла
saveBtn.addEventListener('click', () => {
    const file = docUpload.files[0];
    
    saveBtn.innerText = "Відправка... (це може зайняти хвилину)";
    saveBtn.disabled = true;

    const payload = {
        action: "update",
        aptNumber: aptInput.value,
        ownerName: ownerName.value,
        area: aptArea.value
    };

    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            payload.fileBase64 = e.target.result.split(',')[1];
            payload.mimeType = file.type;
            sendUpdateRequest(payload);
        };
        reader.readAsDataURL(file);
    } else {
        sendUpdateRequest(payload);
    }
});

function sendUpdateRequest(payload) {
    fetch(GOOGLE_APP_URL, {
        method: 'POST',
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === "success") {
            alert("Дані успішно оновлено!");
            docUpload.value = ""; 
        } else {
            alert("Помилка: " + data.message);
        }
    })
    .catch(err => {
        alert("Помилка зв'язку з сервером.");
    })
    .finally(() => {
        saveBtn.innerText = "Зберегти та відправити";
        saveBtn.disabled = false;
    });
}

// 4. Кнопка Выхода
document.getElementById('logoutBtn').addEventListener('click', () => {
    dataSection.style.display = "none";
    passwordSection.style.display = "none";
    loginSection.style.display = "block";
    
    passInput.value = "";
    newPassInput.value = "";
    confirmPassInput.value = "";
    docUpload.value = "";
});

function showError(text) {
    loginError.innerText = text;
    loginError.style.display = "block";
}

function showPassError(text) {
    passError.innerText = text;
    passError.style.display = "block";
}
function showError(text) {
    loginError.innerText = text;
    loginError.style.display = "block";
}

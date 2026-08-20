// URL вашего будущего веб-приложения Google (заполним позже)
const GOOGLE_APP_URL = "https://script.google.com/macros/s/AKfycbxsEF6jgoaC0Md4stZsAayt9POU9fibVjo7GvwreAXwTcRB_JgfRcnG2G9NM43S-3rShQ/exec";

// Элементы интерфейса
const loginSection = document.getElementById('loginSection');
const dataSection = document.getElementById('dataSection');
const aptInput = document.getElementById('aptInput');
const passInput = document.getElementById('passInput');
const loginError = document.getElementById('loginError');

const ownerName = document.getElementById('ownerName');
const aptArea = document.getElementById('aptArea');
const docUpload = document.getElementById('docUpload');
const loginBtn = document.getElementById('loginBtn');
const saveBtn = document.getElementById('saveBtn');

// Кнопка Входа
loginBtn.addEventListener('click', () => {
    const apt = aptInput.value;
    const pass = passInput.value;

    if (!apt || !pass) {
        showError("Заповніть усі поля!");
        return;
    }

    loginError.style.display = "none";
    loginBtn.innerText = "Перевірка...";
    loginBtn.disabled = true; // Блокируем кнопку от двойных кликов

    fetch(GOOGLE_APP_URL, {
        method: 'POST',
        body: JSON.stringify({ action: "login", aptNumber: apt, password: pass })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === "success") {
            // Подставляем данные из Google Таблицы в поля
            ownerName.value = data.ownerName || "";
            aptArea.value = data.area || "";
            
            // Меняем экраны
            loginSection.style.display = "none";
            dataSection.style.display = "block";
        } else {
            showError(data.message || "Помилка входу");
        }
    })
    .catch(err => {
        showError("Помилка зв'язку з сервером. Перевірте інтернет.");
        console.error(err);
    })
    .finally(() => {
        loginBtn.innerText = "Увійти";
        loginBtn.disabled = false;
    });
});

// Кнопка Выхода
document.getElementById('logoutBtn').addEventListener('click', () => {
    dataSection.style.display = "none";
    loginSection.style.display = "block";
    passInput.value = "";
    docUpload.value = ""; // Очищаем поле файла
});

// Кнопка Сохранения
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
        // Если файл не выбрали, просто обновляем текстовые данные
        sendUpdateRequest(payload);
    }
});

// Функция отправки данных
function sendUpdateRequest(payload) {
    fetch(GOOGLE_APP_URL, {
        method: 'POST',
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === "success") {
            alert("Дані успішно оновлено!");
            docUpload.value = ""; // Сбрасываем выбранный файл после успеха
        } else {
            alert("Помилка: " + data.message);
        }
    })
    .catch(err => {
        alert("Помилка зв'язку з сервером.");
        console.error(err);
    })
    .finally(() => {
        saveBtn.innerText = "Зберегти та відправити";
        saveBtn.disabled = false;
    });
}

function showError(text) {
    loginError.innerText = text;
    loginError.style.display = "block";
}

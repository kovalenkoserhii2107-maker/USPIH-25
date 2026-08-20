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

// Кнопка Входа
document.getElementById('loginBtn').addEventListener('click', () => {
    const apt = aptInput.value;
    const pass = passInput.value;

    if (!apt || !pass) {
        loginError.style.display = "block";
        loginError.innerText = "Заповніть усі поля!";
        return;
    }

    loginError.style.display = "none";
    // Временно меняем экраны без сервера для теста. 
    // Позже здесь будет fetch-запрос к GOOGLE_APP_URL
    console.log(`Пробуем войти: Кв ${apt}, Пароль ${pass}`);
    
    // Имитация успешного входа:
    loginSection.style.display = "none";
    dataSection.style.display = "block";
});

// Кнопка Выхода
document.getElementById('logoutBtn').addEventListener('click', () => {
    dataSection.style.display = "none";
    loginSection.style.display = "block";
    passInput.value = "";
});

// Кнопка Сохранения и загрузки файла
document.getElementById('saveBtn').addEventListener('click', () => {
    const file = docUpload.files[0];
    
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            // Отрезаем префикс, оставляем только чистый base64
            const base64Data = e.target.result.split(',')[1]; 
            
            const payload = {
                action: "update",
                aptNumber: aptInput.value,
                ownerName: ownerName.value,
                area: aptArea.value,
                fileBase64: base64Data,
                mimeType: file.type
            };
            
            console.log("Готово к отправке на Google Диск:", payload);
            alert("Імітація відправки: подивіться консоль розробника");
            // Позже здесь будет fetch-запрос на отправку payload
        };
        reader.readAsDataURL(file);
    } else {
        alert("Оберіть файл перед збереженням!");
    }
});

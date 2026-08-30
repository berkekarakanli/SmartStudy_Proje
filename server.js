
// .env dosyası SADECE yerelde var (git'e gitmiyor); Render'da bu değerler
// zaten kendi ortam değişkenleri panelinden geliyor - orada .env dosyası
// olmadığı için dotenv sessizce hiçbir şey yapmadan geçer, hataya sebep olmaz.
require('dotenv').config({ quiet: true });

const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const ejs = require('ejs');
const { readNetFromOpticImage } = require('./geminiService');

const app = express();

// Render (ve genel olarak her reverse proxy arkasındaki Node servisi) için
// zorunlu: bu olmadan Express "secure" cookie'yi doğru işleyemez ve
// express-session hiçbir zaman oturum çerezini tarayıcıya yazmaz. Bunun
// eksik olması "Oturum süresi doldu" hatasının asıl sebeplerinden biriydi.
app.set('trust proxy', 1);

// ==========================================
// 0. CORS VE GÜVENLİK AYARLARI (GÜNCELLENDİ)
// ==========================================
app.use(cors({
    // Firebase Hosting tamamen bırakıldı - site artık tek adresten (Render)
    // sunuluyor, index/login/register de aynı sunucudan geliyor (bkz.
    // aşağıdaki '/', '/login', '/register' rotaları), yani normal şartlarda
    // cross-origin isteğe hiç gerek yok. localhost sadece yerel geliştirme için.
    origin: ['http://localhost:3000', 'http://localhost:5000'],
    credentials: true
}));

// ==========================================
// 1. SUPABASE BAŞLATMA VE MODÜLLER
// ==========================================
// Firebase Admin (Firestore + Auth) tamamen kaldırıldı - tüm veri ve kimlik
// doğrulama artık Supabase'de. serviceAccountKey.json / FIREBASE_SERVICE_ACCOUNT
// artık gerekmiyor.
const { supabase, supabaseAuthClient } = require('./supabaseClient');

const PORT = process.env.PORT || 3000;

// GÜVENLİK: Eskiden SESSION_SECRET tanımlı değilse sabit, GitHub'da herkesin
// görebileceği bir değere ('smartstudy-dev-secret-change-me') sessizce
// düşülüyordu - Render'da bu değişkeni tanımlamayı unutursak, bu sabit
// değeri bilen biri sahte oturum çerezi üretip başkasının hesabına
// girebilirdi. Şimdi: gerçek bir sunucuda (Render veya NODE_ENV=production)
// bu değişken yoksa sunucu AÇILMIYOR (sessiz bir güvenlik açığından iyidir);
// yerel geliştirmede ise her açılışta rastgele, tahmin edilemez bir anahtar
// üretiliyor (sabit bir değer yerine).
if (!process.env.SESSION_SECRET && (process.env.RENDER || process.env.NODE_ENV === 'production')) {
    console.error('[GÜVENLİK] SESSION_SECRET ortam değişkeni tanımlı değil! Render\'ın Environment sekmesinden rastgele, uzun bir değer tanımlayın. Bu olmadan sunucu güvenli şekilde başlatılamaz.');
    process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// express.json()'ın varsayılan gövde limiti 100kb - hata defterine bir
// fotoğraf base64 olarak eklenirken (gerçek bir telefon fotoğrafı kolayca
// birkaç MB oluyor) bu limit aşılıyor, istek sunucuya hiç ulaşmadan 413
// ile reddediliyordu. O cevap JSON olmadığı için istemcideki res.json()
// da sessizce patlıyor, kullanıcı ne başarı ne hata mesajı görmüyordu.
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.use(express.json({ limit: '12mb' }));

// Sadece /audio klasörü statik olarak servis ediliyor (ör. pomodoro alarm
// sesi). Bilinçli olarak public/'in tamamını statik açmıyoruz - o klasörde
// gerçek kullanıcı verisiyle doldurulması gereken .html şablonları da var;
// blanket bir express.static bunları render edilmemiş/ham haliyle sızdırırdı.
app.use('/audio', express.static(path.join(__dirname, 'public', 'audio')));

// Ortama göre çerez ayarı (Lokalde false, canlıda (Render/Firebase) true ve none olur)
const isProduction = process.env.NODE_ENV === 'production';

// OTURUMLARIN KALICI HALE GETİRİLMESİ:
// express-session varsayılan olarak oturumları sunucu BELLEĞİNDE tutar
// (MemoryStore). Bu, her sunucu yeniden başlatmasında (her deploy VEYA
// Render'ın kendi periyodik/otomatik yeniden başlatmaları) TÜM aktif
// oturumların sıfırlanmasına yol açıyordu - tekrarlayan "giriş yaptım,
// sayfa yenilendi, bir daha giriş yapmam gerekti" şikayetinin asıl kök
// sebebi buydu (UptimeRobot sadece "uykuya dalmayı" önlüyor, bu farklı
// bir sorun). Oturumlar artık Supabase'deki "sessions" tablosunda
// saklanıyor - böylece sunucu yeniden başlasa bile oturumlar hayatta kalıyor.
class SupabaseSessionStore extends session.Store {
    async get(sid, callback) {
        try {
            const { data, error } = await supabase.from('sessions').select('session, expires').eq('sid', sid).maybeSingle();
            if (error) return callback(error);
            if (!data) return callback(null, null);
            if (new Date(data.expires).getTime() < Date.now()) {
                supabase.from('sessions').delete().eq('sid', sid).then(() => {});
                return callback(null, null);
            }
            callback(null, data.session);
        } catch (e) {
            callback(e);
        }
    }
    async set(sid, sessionData, callback) {
        try {
            const maxAge = (sessionData.cookie && sessionData.cookie.maxAge) || (1000 * 60 * 60 * 24);
            const { error } = await supabase.from('sessions').upsert({
                sid,
                session: sessionData,
                expires: new Date(Date.now() + maxAge).toISOString()
            });
            callback(error || null);
        } catch (e) {
            callback(e);
        }
    }
    async destroy(sid, callback) {
        try {
            const { error } = await supabase.from('sessions').delete().eq('sid', sid);
            callback(error || null);
        } catch (e) {
            callback(e);
        }
    }
    touch(sid, sessionData, callback) {
        return this.set(sid, sessionData, callback);
    }
}

app.use(session({
    store: new SupabaseSessionStore(),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: isProduction ? 'none' : 'lax',
        secure: isProduction,
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// Her ekranın kendi görünüm dosyası (backend/views/*.ejs) olması için:
// artık her sayfanın HTML'i server.js içine gömülü dev string olarak değil,
// kendi ayrı dosyasında duruyor ve gerçek kullanıcı verisiyle burada
// render ediliyor.
// Görünüm dosyaları .ejs değil, gerçek .html uzantısıyla ve hepsi
// backend/public/ klasöründe duruyor (istek üzerine, index/login/register
// ile aynı yerde görülebilsinler diye). Bu dosyalar gerçek kullanıcı
// verisiyle sunucu tarafında dolduruluyor; bu yüzden firebase.json'da
// Firebase Hosting'in bunları OLDUĞU GİBİ (işlenmemiş EJS şablonu olarak)
// yayınlamaması için "ignore" listesine eklendiler - sadece Express/Render
// üzerinden render edilerek servis ediliyorlar.
app.engine('html', ejs.renderFile);
app.set('view engine', 'html');
app.set('views', path.join(__dirname, 'public'));

// ==========================================
// 1b. KABA KUVVET (BRUTE-FORCE) KORUMASI
// ==========================================
// Aynı IP'den kısa sürede çok fazla giriş/kayıt/şifre denemesi engellenir.
function rateLimitJsonHandler(req, res) {
    res.status(429).json({ success: false, message: 'Çok fazla deneme yaptınız. Lütfen birkaç dakika sonra tekrar deneyin.' });
}

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 dakika
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitJsonHandler
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 saat
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        if (wantsJson(req)) return rateLimitJsonHandler(req, res);
        res.status(429).send(errorPage('Çok Fazla Deneme', 'Bu IP adresinden çok fazla kayıt denemesi yapıldı. Lütfen birkaç dakika sonra tekrar deneyin.', '/register'));
    }
});

const sensitiveActionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitJsonHandler
});

// ==========================================
// 2. YARDIMCI VE GÜVENLİK FONKSİYONLARI
// ==========================================
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
    return `pbkdf2$${salt}$${hash}`;
}

function verifyPassword(password, storedPassword) {
    if (!storedPassword) return false;
    if (!storedPassword.startsWith('pbkdf2$')) return password === storedPassword;
    const [, salt, storedHash] = storedPassword.split('$');
    const candidate = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256');
    const stored = Buffer.from(storedHash, 'hex');
    return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function sendPage(res, fileName) {
    res.sendFile(path.join(__dirname, 'public', fileName));
}

function errorPage(title, message, backUrl = '/') {
    return `
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <title>${escapeHtml(title)}</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    </head>
    <body class="bg-dark text-white d-flex align-items-center justify-content-center min-vh-100">
        <main class="text-center p-4">
            <h1 class="text-warning mb-3">${escapeHtml(title)}</h1>
            <p class="text-white-50">${escapeHtml(message)}</p>
            <a class="btn btn-outline-info mt-3" href="${escapeHtml(backUrl)}">Geri Dön</a>
        </main>
    </body>
    </html>`;
}

// errorPage'in aynısı ama yeşil/olumlu vurguyla - kayıt sonrası "e-postanı
// doğrula" gibi hata olmayan ama bilgilendirici mesajlar için.
function infoPage(title, message, backUrl = '/') {
    return `
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <title>${escapeHtml(title)}</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    </head>
    <body class="bg-dark text-white d-flex align-items-center justify-content-center min-vh-100">
        <main class="text-center p-4">
            <h1 class="text-info mb-3">${escapeHtml(title)}</h1>
            <p class="text-white-50">${escapeHtml(message)}</p>
            <a class="btn btn-outline-info mt-3" href="${escapeHtml(backUrl)}">Giriş Sayfasına Git</a>
        </main>
    </body>
    </html>`;
}

function parseNet(value) {
    const net = Number(value); 
    return Number.isFinite(net) ? net : NaN; 
}

function formatNet(value) { 
    return Number(value || 0).toFixed(2); 
}

function buildDailyTasks(analysis) {
    if (!analysis) {
        return [
            'Sisteme veri girmek için ilk deneme netlerini ekle.', 
            'Akademik durumunu görebilmemiz için analiz başlat.'
        ];
    }
    const lessons = [
        { name: 'Matematik', value: Number(analysis.matematik || 0), max: 40, lowTask: '25 problem + temel işlem', midTask: '20 yeni nesil problem', highTask: '1 branş denemesi' },
        { name: 'Türkçe', value: Number(analysis.turkce || 0), max: 40, lowTask: '30 paragraf', midTask: '20 paragraf + dil bilgisi', highTask: 'Süreli Türkçe denemesi' },
        { name: 'Fen', value: Number(analysis.fen || 0), max: 20, lowTask: '1 konu videosu + 40 soru', midTask: 'Fen branş denemesi', highTask: 'Zor seviye tarama testi' },
        { name: 'Sosyal', value: Number(analysis.sosyal || 0), max: 20, lowTask: 'Kavram kartları + 30 soru', midTask: 'Sosyal branş denemesi', highTask: 'Karma sosyal denemesi' }
    ];
    return lessons.sort((a, b) => (a.value / a.max) - (b.value / b.max)).slice(0, 3).map(l => {
        const ratio = l.value / l.max;
        return `${l.name}: ${ratio < 0.45 ? l.lowTask : ratio < 0.78 ? l.midTask : l.highTask}`;
    });
}

// ==========================================
// 3. OTURUM YÖNETİMİ VE KONTROLLERİ
// ==========================================
function wantsJson(req) {
    return req.headers['content-type'] === 'application/json' || req.xhr || req.headers.accept?.includes('json');
}

async function requireLogin(req, res, next) {
    if (!req.session.userId) {
        if (wantsJson(req)) {
            return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });
        }
        return res.redirect('/login');
    }
    next();
}

async function currentUser(req) {
    if (!req.session.userId) return null;
    const { data, error } = await supabase.from('profiles').select('*').eq('id', req.session.userId).maybeSingle();
    if (error || !data) return null;
    return data;
}

// Flutter (mobil) istemcisi session çerezi taşıyamadığı için, kimliğini
// "Authorization: Bearer <token>" başlığında gönderdiği bir Supabase erişim
// tokeniyle kanıtlıyor - bu token /login'de üretiliyor. Token'ı Supabase'e
// sorup GERÇEKTEN o token'a ait kullanıcıyı buluyoruz.
//
// GÜVENLİK NOTU: Eskiden bu fonksiyon, istemcinin request body/query'sinde
// gönderdiği çıplak bir "userId" değerine hiçbir doğrulama yapmadan
// güveniyordu - yani biri başka bir kullanıcının ID'sini bilse/ele geçirse,
// o kullanıcı gibi davranıp verilerini görebilir/silebilir, hatta kendini
// Premium yapabilirdi. Bu ciddi bir kimliğe bürünme açığıydı, şimdi
// kapatıldı. Flutter tarafı bu token'ı gönderecek şekilde güncellenene kadar
// mobil uçlar (bilinçli olarak) çalışmayacak.
async function resolveUser(req) {
    const sessionUser = await currentUser(req);
    if (sessionUser) return sessionUser;

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token) return null;

    const { data: tokenData, error: tokenError } = await supabase.auth.getUser(token);
    if (tokenError || !tokenData?.user) return null;

    const { data, error } = await supabase.from('profiles').select('*').eq('id', tokenData.user.id).maybeSingle();
    if (error || !data) return null;
    return data;
}

// /generate-plan, /assign-homework, /api/teacher-data gibi hem web (session)
// hem mobil (explicit userId) tarafından çağrılan uçlar için ortak middleware.
async function requireUser(req, res, next) {
    const user = await resolveUser(req);
    if (!user) {
        if (wantsJson(req)) {
            return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });
        }
        return res.redirect('/login');
    }
    req.currentUser = user;
    next();
}

function syncSessionUser(req, user) {
    req.session.userId = user.id;
    req.session.userName = user.ad;
    req.session.userLevel = user.level || 'Free';
    req.session.userRole = user.role || 'student';
}

// ==========================================
// 4. STATİK VE TEMEL ROTALAR
// ==========================================
app.get('/', (req, res) => sendPage(res, 'index.html'));
app.get('/login', (req, res) => sendPage(res, 'login.html'));
app.get('/register', (req, res) => sendPage(res, 'register.html'));
app.get('/plan', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user) return res.redirect('/login');
        if (user.role === 'teacher' && !user.teacher_type) {
            return res.redirect('/teacher-setup');
        }

        const isStudent = user.role !== 'teacher';
        let teacherData = null;

        if (!isStudent) {
            const { data: students } = await supabase.from('profiles')
                .select('id, ad, email')
                .eq('role', 'student')
                .eq('bagli_koc_kodu', user.koc_kodu);

            teacherData = {
                teacher_type: user.teacher_type || 'koc',
                branch: user.branch || '',
                students: students || []
            };
        }

        res.render('analysis', { user, isStudent, teacherData });
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Analiz terminali yüklenirken sorun oluştu.', '/dashboard'));
    }
});

// EĞİTMEN VERİ API
app.get('/api/teacher-data', requireUser, async (req, res) => {
    try {
        const user = req.currentUser;
        if (!user || user.role !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Yetkisiz erişim' });
        }

        const { data: students } = await supabase.from('profiles')
            .select('*')
            .eq('role', 'student')
            .eq('bagli_koc_kodu', user.koc_kodu);

        res.json({
            success: true,
            teacher_type: user.teacher_type || 'koc',
            branch: user.branch || '',
            students: students || []
        });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// EĞİTMEN PROFİL KURULUMU
app.get('/teacher-setup', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user || user.role !== 'teacher') return res.redirect('/dashboard');
        if (user.teacher_type) return res.redirect('/dashboard');

        res.render('teacher-setup');
    } catch (e) {
        res.redirect('/dashboard');
    }
});

app.post('/teacher-setup', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user || user.role !== 'teacher') return res.redirect('/dashboard');

        const teacher_type = req.body.teacher_type === 'brans' ? 'brans' : 'koc';
        const branch = teacher_type === 'brans' ? String(req.body.branch || 'Türkçe / Türk Dili ve Edebiyatı') : null;

        await supabase.from('profiles').update({ teacher_type, branch }).eq('id', user.id);

        res.redirect('/dashboard');
    } catch (e) {
        res.redirect('/teacher-setup');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// index.html (statik anasayfa - Firebase Hosting'de de yayında) kendi
// başına giriş durumunu bilemiyor; bu uç, sayfanın üst menüsünün "Giriş
// Yap/Kayıt Ol" yerine "Hesabım/Çıkış Yap" göstermesi için kullanılıyor.
app.get('/api/me', async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, ad: user.ad, level: user.level || 'Free' });
});

// ==========================================
// 5. KİMLİK DOĞRULAMA VE KAYIT (AUTH)
// ==========================================
app.post('/register', registerLimiter, async (req, res) => {
    try {
        const ad = String(req.body.ad || '').trim();
        const email = String(req.body.email || '').trim().toLowerCase();
        const sifre = String(req.body.sifre || '');
        const role = req.body.role === 'teacher' ? 'teacher' : 'student';

        // İstemci tarafı (JS) doğrulaması atlanabildiği için (curl, geliştirici
        // araçları vb.) aynı kontrolleri burada, sunucu tarafında da yapıyoruz.
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!ad || ad.length < 2 || !email || !emailPattern.test(email) || sifre.length < 8) {
            const msg = 'Tüm alanları doğru doldurun (isim en az 2 karakter, geçerli bir e-posta, şifre en az 8 karakter olmalı).';
            if (wantsJson(req)) return res.status(400).json({ success: false, message: msg });
            return res.status(400).send(errorPage('Kayıt Hatası', msg, '/register'));
        }

        // Web (Bootstrap) kayıt formu artık KVKK Aydınlatma Metni ve Üyelik
        // Sözleşmesi onay kutuları gönderiyor; native form submit olduğu için
        // burada da (istemci tarafındaki 'required' kontrolüne ek olarak)
        // sunucu tarafında doğrulanıyor. Flutter tarafı henüz bu kutucukları
        // göndermiyor (JSON isteği), o yüzden bu kontrol yalnızca web formuna
        // uygulanıyor.
        const kvkkOnayVerildi = req.body.kvkk_onay === 'on';
        const sozlesmeOnayVerildi = req.body.sozlesme_onay === 'on';
        if (!wantsJson(req) && (!kvkkOnayVerildi || !sozlesmeOnayVerildi)) {
            return res.status(400).send(errorPage('Kayıt Hatası', 'Devam etmek için KVKK Aydınlatma Metni\'ni ve Üyelik Sözleşmesi\'ni onaylamalısınız.', '/register'));
        }

        // Davet (referans) sistemi: her kullanıcının kendi kodu var, bu kodla
        // gelen her yeni kayıt referral_count'u artırır; 10'a ulaşınca
        // davet eden otomatik Premium olur. Kullanıcı oluşturulmadan önce
        // referans kodunun geçerli olup olmadığına bakıyoruz.
        const gelenRefKodu = String(req.body.ref || '').trim().toUpperCase();
        let referrer = null;
        if (gelenRefKodu) {
            const { data } = await supabase.from('profiles').select('id, referral_count, level').eq('referral_code', gelenRefKodu).maybeSingle();
            referrer = data || null;
        }

        let kocKodu = null;
        if (role === 'teacher') {
            kocKodu = 'KOC-' + Math.random().toString(36).substr(2, 5).toUpperCase();
        }

        // Kullanıcı Supabase Auth'ta oluşturuluyor (şifre orada güvenli şekilde
        // saklanıyor, artık kendi pbkdf2 hashleme mantığımız YOK). "profiles"
        // tablosundaki karşılık gelen satır, veritabanındaki bir tetikleyici
        // (handle_new_user) tarafından OTOMATİK oluşturuluyor - biz sadece
        // koc_kodu ve referred_by gibi ekstra alanları sonradan güncelliyoruz.
        //
        // ÖNEMLİ: admin.createUser() DEĞİL, bilinçli olarak PUBLIC signUp()
        // kullanıyoruz (anon anahtarlı supabaseAuthClient üzerinden) - sadece
        // signUp(), Supabase'in Authentication > Emails kısmında ayarladığımız
        // "Confirm sign up" e-postasını OTOMATİK gönderiyor. admin.createUser()
        // bunu tetiklemiyor. E-posta artık bir LİNK değil, 8 haneli bir KOD
        // içeriyor (Supabase şablonundaki {{ .Token }} değişkeni) -
        // kullanıcı bu kodu /verify-email sayfasına yazıyor.
        const { data: authData, error: authError } = await supabaseAuthClient.auth.signUp({
            email,
            password: sifre,
            options: {
                data: { ad, role, kvkk_onay: kvkkOnayVerildi, sozlesme_onay: sozlesmeOnayVerildi }
            }
        });

        if (authError) {
            console.error(authError);
            const msg = 'Kayıt işlemi sırasında hata oluştu.';
            if (wantsJson(req)) return res.status(500).json({ success: false, message: msg });
            return res.status(500).send(errorPage('Sunucu Hatası', msg, '/register'));
        }

        // Supabase, e-posta numaralandırma saldırılarını önlemek için, zaten
        // kayıtlı+doğrulanmış bir e-postayla signUp() çağrılınca hata
        // DÖNDÜRMÜYOR - bunun yerine user.identities dizisini boş bırakıyor.
        // "Zaten kayıtlı" kontrolünü bu yüzden böyle yapıyoruz.
        const isDuplicate = authData.user && Array.isArray(authData.user.identities) && authData.user.identities.length === 0;
        if (isDuplicate) {
            const msg = 'Bu e-posta sistemde zaten kayıtlı.';
            if (wantsJson(req)) return res.status(409).json({ success: false, message: msg });
            return res.status(409).send(errorPage('Kayıt Hatası', msg, '/register'));
        }

        const newUserId = authData.user.id;
        await supabase.from('profiles').update({
            koc_kodu: kocKodu,
            referred_by: referrer ? referrer.id : null
        }).eq('id', newUserId);

        if (referrer) {
            const yeniSayi = Number(referrer.referral_count || 0) + 1;
            const referrerUpdates = { referral_count: yeniSayi };
            // Her 10 davette bir Premium ödülü (zaten Premium'sa dokunmuyor).
            if (yeniSayi % 10 === 0 && referrer.level !== 'Premium') {
                referrerUpdates.level = 'Premium';
            }
            await supabase.from('profiles').update(referrerUpdates).eq('id', referrer.id);
        }

        if (wantsJson(req)) {
            return res.json({
                success: true,
                userId: newUserId,
                id: newUserId,
                role,
                emailConfirmationRequired: true,
                message: `${email} adresine 8 haneli bir doğrulama kodu gönderdik. Giriş yapmadan önce e-postanı doğrulaman gerekiyor.`
            });
        }
        res.redirect('/verify-email?email=' + encodeURIComponent(email));
    } catch (error) {
        console.error(error);
        const msg = 'Kayıt işlemi sırasında hata oluştu.';
        if (wantsJson(req)) return res.status(500).json({ success: false, message: msg });
        res.status(500).send(errorPage('Sunucu Hatası', msg, '/register'));
    }
});

// ==========================================
// 5C. E-POSTA DOĞRULAMA (KOD TABANLI)
// ==========================================
function verifyEmailForm(email, message, isError) {
    return authShell({
        title: 'E-Postanı Doğrula',
        subtitleHtml: `<strong class="text-info">${escapeHtml(email)}</strong> adresine gönderdiğimiz 8 haneli kodu gir.`,
        icon: 'fa-envelope-open-text',
        bodyHtml: `
            ${message ? `<div class="alert-box ${isError ? 'error' : 'info'}">${escapeHtml(message)}</div>` : ''}
            <form method="POST" action="/verify-email">
                <input type="hidden" name="email" value="${escapeHtml(email)}">
                <div class="field">
                    <label class="form-label">Doğrulama Kodu</label>
                    <input type="text" name="code" class="form-control space-input code-input" placeholder="········" inputmode="numeric" maxlength="8" required autofocus>
                </div>
                <button type="submit" class="btn-access orbitron">Doğrula</button>
            </form>`
    });
}

app.get('/verify-email', (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    res.send(verifyEmailForm(email));
});

app.post('/verify-email', sensitiveActionLimiter, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();

    if (!email || !code) {
        return res.send(verifyEmailForm(email, 'E-posta ve kod gerekli.', true));
    }

    const { error } = await supabaseAuthClient.auth.verifyOtp({ email, token: code, type: 'signup' });
    if (error) {
        return res.send(verifyEmailForm(email, 'Kod geçersiz veya süresi dolmuş. Kayıt sayfasından tekrar dene ya da destek ile iletişime geç.', true));
    }

    res.send(infoPage('E-Postan Doğrulandı', 'Tebrikler, e-postan doğrulandı! Şimdi giriş yapabilirsin.', '/login'));
});

app.post('/login', loginLimiter, async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const sifre = String(req.body.sifre || '');
        const requestedRole = req.body.requestedRole;

        if (!email || !sifre) {
            return res.status(400).json({ success: false, message: 'E-posta ve şifre gerekli.' });
        }

        // Şifre doğrulaması artık Supabase Auth'ta yapılıyor - kendi
        // pbkdf2/hashPassword mantığımıza hiç gerek kalmadı. E-postasını
        // henüz doğrulamamış kullanıcılar için Supabase kendi tarafında
        // girişi zaten reddediyor ("Email not confirmed" hatası) - biz
        // sadece bu durumu kullanıcının anlayacağı bir mesaja çeviriyoruz.
        const { data: signInData, error: signInError } = await supabaseAuthClient.auth.signInWithPassword({ email, password: sifre });
        if (signInError || !signInData.user) {
            if (signInError && /email.*not.*confirmed/i.test(signInError.message || '')) {
                return res.status(403).json({
                    success: false,
                    message: 'E-postanı henüz doğrulamadın. Kayıt olurken gönderdiğimiz kodu girmeden giriş yapamazsın.',
                    emailNotConfirmed: true
                });
            }
            return res.status(401).json({ success: false, message: 'E-Posta veya şifre hatalı.' });
        }

        const { data: user, error: profileError } = await supabase.from('profiles').select('*').eq('id', signInData.user.id).maybeSingle();
        if (profileError || !user) {
            return res.status(500).json({ success: false, message: 'Profil bulunamadı.' });
        }

        if (requestedRole && user.role !== requestedRole) {
            return res.status(403).json({ success: false, message: `Bu hesaba ${requestedRole === 'teacher' ? 'Eğitmen' : 'Öğrenci'} olarak giriş yapılamaz.` });
        }

        syncSessionUser(req, user);
        // "Beni hatırla" işaretliyse oturum çerezi 30 gün, değilse varsayılan
        // 24 saat sürüyor.
        if (req.body.rememberMe) {
            req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
        }
        // accessToken: mobil (Flutter) istemcisi web'deki gibi çerez (cookie)
        // taşıyamadığı için, kimliğini kanıtlamak amacıyla bundan sonraki
        // isteklerinde bu token'ı "Authorization: Bearer <token>" başlığında
        // göndermesi gerekiyor - resolveUser() bu token'ı Supabase'e sorup
        // doğruluyor. (Flutter tarafı bunu kullanacak şekilde güncellenene
        // kadar mobil uçlar bu token olmadan çalışmaz - bilinçli bir karar,
        // eskiden istemcinin "ben buyum" diye gönderdiği userId'ye körü
        // körüne güvenilmesi ciddi bir kimliğe bürünme açığıydı.)
        res.json({
            success: true,
            role: user.role,
            userId: user.id,
            id: user.id,
            level: user.level || 'Free',
            accessToken: signInData.session ? signInData.session.access_token : null
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Sunucu bağlantı hatası.' });
    }
});

// ==========================================
// 5B. ŞİFREMİ UNUTTUM (KOD TABANLI)
// ==========================================
// ÖNEMLİ: Link tabanlı akış (Supabase'in linke tıklayınca tarayıcıyı
// yönlendirmesi) Site URL / Redirect URLs ayarlarına bağımlı olduğu ve
// bu ayarların doğru olmadığı durumlarda kullanıcıyı yanlış yere (hatta
// localhost'a) göndermeye çok açık olduğu için, bunun yerine kullanıcının
// e-postasına gelen 8 haneli kodu doğrudan bu sayfaya yazdığı bir akış
// kullanıyoruz - hiçbir yönlendirmeye ihtiyaç yok, tamamen bu sunucudan
// yönetiliyor.
//
// authShell: login.html ile birebir aynı görsel dili (Orbitron font,
// camgöbeği/mavi tema, cam efektli kart) kullanan, bu sunucu-taraflı
// (server-rendered) doğrulama sayfaları için ortak kabuk. Böylece
// "Şifremi Unuttum", "E-Postanı Doğrula" ve "Yeni Şifre Belirle" ekranları
// login/register sayfalarıyla aynı siteden geliyormuş gibi hissettiriyor.
function authShell({ title, subtitleHtml, icon = 'fa-shield-halved', bodyHtml, backHref = '/login', backLabel = 'Giriş Sayfasına Dön' }) {
    return `
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SmartStudy | ${escapeHtml(title)}</title>
        <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Inter:wght@300;500;700&display=swap" rel="stylesheet">
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
        <style>
            :root { --theme-color: #0dcaf0; --theme-gradient: linear-gradient(135deg, #0dcaf0 0%, #007bff 100%); --theme-shadow: rgba(13, 202, 240, 0.4); }
            * { box-sizing: border-box; }
            body { margin: 0; min-height: 100vh; width: 100%; background-color: #020617; color: #f8fafc; font-family: 'Inter', sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 16px; }
            .orbitron { font-family: 'Orbitron', sans-serif; }
            .auth-card { background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(20px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 28px; padding: 44px 40px; width: 100%; max-width: 420px; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5); }
            @media (max-width: 480px) { .auth-card { padding: 32px 22px; border-radius: 22px; } body { padding: 24px 14px; } }
            .icon-badge { width: 68px; height: 68px; border-radius: 50%; background: rgba(13, 202, 240, 0.12); display: flex; align-items: center; justify-content: center; margin: 0 auto 22px; border: 1px solid rgba(13, 202, 240, 0.35); box-shadow: 0 0 24px var(--theme-shadow); }
            .icon-badge i { font-size: 1.7rem; color: var(--theme-color); }
            h3.orbitron { color: #f8fafc; letter-spacing: 1px; }
            .form-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 1.5px; color: #94a3b8; margin-bottom: 8px; display: block; text-align: left; }
            .input-group-text { background: rgba(2, 6, 23, 0.8); border: 1px solid rgba(255, 255, 255, 0.08); color: #64748b; }
            .space-input { background: rgba(2, 6, 23, 0.8) !important; border: 1px solid rgba(255, 255, 255, 0.08) !important; color: #f8fafc !important; }
            .space-input::placeholder { color: #64748b; }
            .space-input:focus { border-color: var(--theme-color) !important; box-shadow: 0 0 0 0.2rem var(--theme-shadow) !important; }
            .code-input { letter-spacing: 8px; font-size: 1.3rem; font-weight: 700; text-align: center; }
            .field { margin-bottom: 18px; text-align: left; }
            .btn-access { border: none; color: #000; font-weight: 800; padding: 14px; border-radius: 12px; width: 100%; text-transform: uppercase; letter-spacing: 2px; transition: 0.3s; cursor: pointer; background: var(--theme-gradient); font-size: 0.9rem; }
            .btn-access:hover { box-shadow: 0 10px 25px var(--theme-shadow); transform: translateY(-1px); }
            .bottom-link { color: var(--theme-color); text-decoration: none; font-weight: 600; }
            .bottom-link:hover { text-decoration: underline; }
            .back-home { color: #64748b; text-decoration: none; font-size: 0.85rem; margin-top: 28px; display: inline-block; }
            .back-home:hover { color: var(--theme-color); }
            .alert-box { border-radius: 14px; padding: 12px 16px; font-size: 0.85rem; margin-bottom: 18px; text-align: left; }
            .alert-box.info { background: rgba(13, 202, 240, 0.1); border: 1px solid rgba(13, 202, 240, 0.3); color: #7dd8ec; }
            .alert-box.error { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5; }
        </style>
    </head>
    <body>
        <main class="auth-card text-center">
            <div class="icon-badge"><i class="fas ${icon}"></i></div>
            <h3 class="orbitron fw-bold mb-2">${escapeHtml(title)}</h3>
            <p class="text-secondary small mb-4" style="line-height: 1.5;">${subtitleHtml}</p>
            ${bodyHtml}
        </main>
        <a href="${backHref}" class="back-home"><i class="fas fa-arrow-left me-1"></i>${escapeHtml(backLabel)}</a>
    </body>
    </html>`;
}

function forgotPasswordForm(message) {
    return authShell({
        title: 'Şifremi Unuttum',
        subtitleHtml: 'Kayıtlı e-posta adresini gir, sana 8 haneli bir doğrulama kodu gönderelim.',
        icon: 'fa-key',
        bodyHtml: `
            ${message ? `<div class="alert-box info">${escapeHtml(message)}</div>` : ''}
            <form method="POST" action="/forgot-password">
                <div class="field">
                    <label class="form-label">E-Posta Adresi</label>
                    <div class="input-group">
                        <span class="input-group-text"><i class="fas fa-envelope"></i></span>
                        <input type="email" name="email" class="form-control space-input" placeholder="ornek@email.com" required>
                    </div>
                </div>
                <button type="submit" class="btn-access orbitron">Kod Gönder</button>
            </form>`
    });
}

app.get('/forgot-password', (req, res) => {
    res.send(forgotPasswordForm());
});

app.post('/forgot-password', sensitiveActionLimiter, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (email) {
        // Hata olsa bile kullanıcıya her zaman aynı mesajı gösteriyoruz -
        // aksi halde "bu e-posta kayıtlı mı değil mi" bilgisini dışarıya
        // sızdırmış (email enumeration) oluruz. redirectTo artık yok -
        // kod tabanlı akışta hiç kullanılmıyor.
        try {
            await supabaseAuthClient.auth.resetPasswordForEmail(email);
        } catch (error) {
            console.error(error);
        }
    }
    res.redirect('/reset-password?email=' + encodeURIComponent(email));
});

function resetPasswordForm(email, message, isError) {
    return authShell({
        title: 'Yeni Şifre Belirle',
        subtitleHtml: `<strong class="text-info">${escapeHtml(email)}</strong> adresine gönderdiğimiz 8 haneli kodu ve yeni şifreni gir.`,
        icon: 'fa-lock',
        backHref: '/forgot-password',
        backLabel: 'Kodu Tekrar Gönder',
        bodyHtml: `
            ${message ? `<div class="alert-box ${isError ? 'error' : 'info'}">${escapeHtml(message)}</div>` : ''}
            <form method="POST" action="/reset-password">
                <input type="hidden" name="email" value="${escapeHtml(email)}">
                <div class="field">
                    <label class="form-label">Doğrulama Kodu</label>
                    <input type="text" name="code" class="form-control space-input code-input" placeholder="········" inputmode="numeric" maxlength="8" required autofocus>
                </div>
                <div class="field">
                    <label class="form-label">Yeni Şifre</label>
                    <div class="input-group">
                        <span class="input-group-text"><i class="fas fa-lock"></i></span>
                        <input type="password" name="newPassword" class="form-control space-input" placeholder="En az 8 karakter" minlength="8" required>
                    </div>
                </div>
                <button type="submit" class="btn-access orbitron">Şifreyi Güncelle</button>
            </form>`
    });
}

app.get('/reset-password', (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    res.send(resetPasswordForm(email));
});

app.post('/reset-password', sensitiveActionLimiter, async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const code = String(req.body.code || '').trim();
        const newPassword = String(req.body.newPassword || '');

        if (!email || !code || newPassword.length < 8) {
            return res.send(resetPasswordForm(email, 'Kod ve en az 8 karakterlik yeni şifre gerekli.', true));
        }

        // Kodu doğrulamak için Supabase'e soruyoruz - başarılı olursa bize
        // o kullanıcı için geçici bir oturum (session) döndürüyor, biz de
        // service_role ile doğrudan şifresini güncelliyoruz.
        const { data, error } = await supabaseAuthClient.auth.verifyOtp({ email, token: code, type: 'recovery' });
        if (error || !data.user) {
            return res.send(resetPasswordForm(email, 'Kod geçersiz veya süresi dolmuş. Tekrar kod isteyebilirsin.', true));
        }

        const { error: updateError } = await supabase.auth.admin.updateUserById(data.user.id, { password: newPassword });
        if (updateError) {
            console.error(updateError);
            return res.send(resetPasswordForm(email, 'Şifre güncellenemedi, tekrar dene.', true));
        }

        res.send(infoPage('Şifre Güncellendi', 'Şifren başarıyla güncellendi. Şimdi yeni şifrenle giriş yapabilirsin.', '/login'));
    } catch (error) {
        console.error(error);
        res.send(resetPasswordForm(String(req.body.email || ''), 'Beklenmeyen bir hata oluştu, tekrar dene.', true));
    }
});

// ==========================================
// 6. ÇOKLU KOÇLUK EŞLEŞTİRME
// ==========================================
app.post('/set-coach', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        if (user.role !== 'student') return res.redirect('/dashboard');

        const girilenKod = String(req.body.coachCode || '').trim().toUpperCase();
        const { data: teacher } = await supabase.from('profiles').select('*').eq('role', 'teacher').eq('koc_kodu', girilenKod).maybeSingle();

        if (!teacher) {
            return res.status(404).send(errorPage('Kod Hatası', 'Geçersiz koç kodu girdiniz.', '/dashboard'));
        }

        const { data: studentData } = await supabase.from('profiles').select('*').eq('id', user.id).single();

        let kocKodlari = studentData.bagli_koc_kodlari || [];
        let kocListesi = studentData.bagli_koc_listesi || [];

        if (!kocKodlari.length && studentData.bagli_koc_kodu) {
            kocKodlari.push(studentData.bagli_koc_kodu);
            kocListesi.push({ kod: studentData.bagli_koc_kodu, ad: studentData.bagli_koc_ad || 'Eğitmen' });
        }

        if (!kocKodlari.includes(girilenKod)) {
            kocKodlari.push(girilenKod);
            kocListesi.push({ kod: girilenKod, ad: teacher.ad });
        }

        await supabase.from('profiles').update({
            bagli_koc_kodlari: kocKodlari,
            bagli_koc_listesi: kocListesi,
            bagli_koc_kodu: girilenKod,
            bagli_koc_ad: teacher.ad
        }).eq('id', user.id);

        res.redirect('/dashboard');
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Koç eşleştirmesi yapılırken sorun oluştu.', '/dashboard'));
    }
});

app.post('/remove-coach', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        if (user.role !== 'student') return res.redirect('/dashboard');

        const coachCodeToRemove = String(req.body.coachCode || '').trim().toUpperCase();
        const { data: studentData } = await supabase.from('profiles').select('*').eq('id', user.id).single();

        let kocKodlari = studentData.bagli_koc_kodlari || [];
        let kocListesi = studentData.bagli_koc_listesi || [];

        kocKodlari = kocKodlari.filter(k => k !== coachCodeToRemove);
        kocListesi = kocListesi.filter(item => item.kod !== coachCodeToRemove);

        let updateData = {
            bagli_koc_kodlari: kocKodlari,
            bagli_koc_listesi: kocListesi
        };

        if (kocKodlari.length > 0) {
            updateData.bagli_koc_kodu = kocKodlari[kocKodlari.length - 1];
            updateData.bagli_koc_ad = kocListesi[kocListesi.length - 1]?.ad || null;
        } else {
            updateData.bagli_koc_kodu = null;
            updateData.bagli_koc_ad = null;
        }

        await supabase.from('profiles').update(updateData).eq('id', user.id);
        res.redirect('/dashboard');
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Koç bağlantısı kesilemedi.', '/dashboard'));
    }
});

// ==========================================
// 7. KONTROL PANELİ (DASHBOARD)
// ==========================================
// Öğrenci panelindeki "Gelişim Trend Grafiği" ve "Geçmiş Analizler" tablosu
// eskiden sınav türünden bağımsız olarak TÜM analizleri tek bir grafikte ve
// sabit TYT sütunlarında (Mat/Türkçe/Fen/Sosyal) gösteriyordu. Bu, farklı
// sınav türlerinin (AYT/KPSS/LGS) derslerini yanlış sütunlara sıkıştırıp
// çoğunu 0 gösteriyordu. Şimdi her sınav türü kendi grafiğinde ve kendi
// ders sütunlarında ayrı ayrı gösteriliyor.
const EXAM_TYPE_LABELS = {
    'TYT': 'TYT',
    'AYT_SAY': 'AYT (Sayısal)',
    'AYT_EA': 'AYT (Eşit Ağırlık)',
    'AYT_SOZ': 'AYT (Sözel)',
    'KPSS': 'KPSS',
    'LGS': 'LGS'
};
const EXAM_TYPE_FIELDS = {
    'TYT': [['mat', 'Mat'], ['turkce', 'Türkçe'], ['fen', 'Fen'], ['sosyal', 'Sosyal']],
    'AYT_SAY': [['mat', 'Mat'], ['fizik', 'Fizik'], ['kimya', 'Kimya'], ['biyoloji', 'Biyoloji']],
    'AYT_EA': [['mat', 'Mat'], ['edebiyat', 'Edebiyat'], ['tarih1', 'Tarih-1'], ['cografya1', 'Coğrafya-1']],
    'AYT_SOZ': [['edebiyat', 'Edebiyat'], ['tarih1', 'Tarih-1'], ['cografya1', 'Coğrafya-1'], ['tarih2', 'Tarih-2'], ['cografya2', 'Coğrafya-2'], ['felsefe', 'Felsefe'], ['din', 'Din/Fels.']],
    'KPSS': [['k_turkce', 'Türkçe'], ['k_mat', 'Mat'], ['k_tarih', 'Tarih'], ['k_cografya', 'Coğrafya'], ['k_vat', 'Vatandaşlık'], ['k_guncel', 'Güncel']],
    'LGS': [['l_turkce', 'Türkçe'], ['l_mat', 'Mat'], ['l_fen', 'Fen'], ['l_inkilap', 'İnkılap'], ['l_din', 'Din K.'], ['l_ingilizce', 'İngilizce']]
};
// Sınav türü sıralaması için sabit öncelik listesi; bilinmeyen bir tür
// gelirse listenin sonuna eklenir.
const EXAM_TYPE_ORDER = ['TYT', 'AYT_SAY', 'AYT_EA', 'AYT_SOZ', 'KPSS', 'LGS'];

function getAnalizFieldValue(analiz, fieldId) {
    if (analiz.detaylar && analiz.detaylar[fieldId] !== undefined) return Number(analiz.detaylar[fieldId]) || 0;
    // Eski (detaylar alanı henüz yokken kaydedilmiş) TYT kayıtları için geriye dönük uyumluluk.
    const legacyMap = { mat: 'matematik', turkce: 'turkce', fen: 'fen', sosyal: 'sosyal' };
    if (legacyMap[fieldId] && analiz[legacyMap[fieldId]] !== undefined) return Number(analiz[legacyMap[fieldId]]) || 0;
    return 0;
}

function groupAnalizlerByExamType(analizler) {
    const groups = {};
    analizler.forEach(a => {
        const key = a.sinav_turu || 'TYT';
        if (!groups[key]) groups[key] = [];
        groups[key].push(a);
    });
    const keys = Object.keys(groups).sort((a, b) => {
        const ia = EXAM_TYPE_ORDER.indexOf(a);
        const ib = EXAM_TYPE_ORDER.indexOf(b);
        if (ia === -1 && ib === -1) return a.localeCompare(b);
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
    });
    return keys.map(key => {
        const fields = EXAM_TYPE_FIELDS[key] || EXAM_TYPE_FIELDS['TYT'];
        const entries = groups[key].map(a => ({
            ...a,
            fieldValues: fields.map(([fieldId]) => getAnalizFieldValue(a, fieldId))
        }));

        // Her modülün (TYT/AYT-Sayısal/AYT-EA/AYT-Sözel/KPSS/LGS) "Son Net" ve
        // "Gelişim İndeksi" değeri SADECE o modülün kendi kayıtlarından
        // hesaplanıyor - başka bir sınav türünün netiyle karışmıyor.
        const sonNet = entries.length > 0 ? Number(entries[entries.length - 1].toplam_net || 0).toFixed(2) : '0.00';
        let gelisim = '0.00';
        let gelisimClass = 'text-success';
        if (entries.length >= 2) {
            const ilkNet = Number(entries[0].toplam_net || 0);
            const sonNetSayi = Number(entries[entries.length - 1].toplam_net || 0);
            const fark = sonNetSayi - ilkNet;
            gelisim = (fark >= 0 ? '+' : '') + fark.toFixed(2);
            gelisimClass = fark >= 0 ? 'text-success' : 'text-danger';
        } else if (entries.length === 1) {
            gelisim = 'Başlangıç';
        }

        return {
            key,
            label: EXAM_TYPE_LABELS[key] || key,
            fields,
            entries,
            analizSayisi: entries.length,
            sonNet,
            gelisim,
            gelisimClass
        };
    });
}

app.get('/dashboard', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user) return res.redirect('/login');

        if (user.role === 'teacher' && !user.teacher_type) {
            return res.redirect('/teacher-setup');
        }

        if (user.role === 'teacher') {
            const { data: snap1 } = await supabase.from('profiles')
                .select('*')
                .eq('role', 'student')
                .contains('bagli_koc_kodlari', [user.koc_kodu]);

            const { data: snap2 } = await supabase.from('profiles')
                .select('*')
                .eq('role', 'student')
                .eq('bagli_koc_kodu', user.koc_kodu);

            const studentMap = new Map();
            (snap1 || []).forEach(s => studentMap.set(s.id, s));
            (snap2 || []).forEach(s => studentMap.set(s.id, s));

            const myStudents = [];
            for (const [sId, sData] of studentMap.entries()) {
                const { data: analizlerRaw } = await supabase.from('analizler').select('*').eq('user_id', sId);
                const analizler = (analizlerRaw || []).sort((a, b) => new Date(b.tarih) - new Date(a.tarih));
                const sonNet = analizler.length > 0 ? Number(analizler[0].toplam_net).toFixed(2) : '0.00';

                myStudents.push({
                    id: sId,
                    ad: sData.ad,
                    email: sData.email,
                    analizSayisi: analizler.length,
                    sonNet: sonNet
                });
            }

            const { data: myAssignedHomeworks } = await supabase.from('homeworks').select('*').eq('teacher_id', user.id);

            const roleBadgeText = user.teacher_type === 'brans' ? `Branş Öğretmeni (${user.branch})` : 'Eğitim Koçu (Genel)';
            const hasNoStudents = myStudents.length === 0;

            res.render('dashboard-teacher', { user, roleBadgeText, myStudents, myAssignedHomeworks: myAssignedHomeworks || [], hasNoStudents });
        } else {
            // Flutter'daki HomeTabContent ile birebir aynı mantık: tüm
            // analizler eskiden-yeniye tek bir listede, sınav türüne göre
            // sekmelere ayrılmadan gösteriliyor.
            const { data: analizlerRaw } = await supabase.from('analizler').select('*').eq('user_id', user.id);
            const analizler = (analizlerRaw || []).sort((a, b) => new Date(a.tarih) - new Date(b.tarih));

            // NOT: "Son Net" ve "Gelişim İndeksi" artık TÜM sınav türlerini
            // karıştırarak tek bir global değer olarak gösterilmiyor - her
            // modülün (TYT/AYT.../KPSS/LGS) kendi değeri var, aşağıdaki
            // groupAnalizlerByExamType() içinde hesaplanıyor.
            const examGroups = groupAnalizlerByExamType(analizler);
            // Sekmeler arasından varsayılan olarak açık gelecek olanı, kullanıcının
            // EN SON girdiği (tarihe göre) analizin sınav türü belirliyor.
            const defaultActiveKey = analizler.length > 0
                ? (analizler[analizler.length - 1].sinav_turu || 'TYT')
                : null;

            res.render('dashboard-student', { user, analizler, examGroups, defaultActiveKey });
        }
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Dashboard yüklenirken sorun oluştu.'));
    }
});

// ==========================================
// 8. PROFİL, ÖDEME VE VİDEO LABORATUVARI
// ==========================================
// Rozet sistemi: hepsi kullanıcının GERÇEK verisinden (kaç analiz yaptı, kaç
// yanlış soru kaydetti, kaç dakika odaklandı, kaç kişi davet etti, vb.)
// hesaplanıyor - hiçbiri sabit/gösterişlik değil, ya kazanılmış ya da kilitli.
function computeBadges({ analizler, wrongCount, pomodoroDakika, referralCount, kocSayisi, isPremium }) {
    const analizCount = analizler.length;
    const maxNet = analizler.reduce((max, a) => Math.max(max, Number(a.toplam_net || 0)), 0);
    const sinavTurleri = new Set(analizler.map(a => (a.sinav_turu || 'TYT').split('_')[0]));
    const hepsiVar = ['TYT', 'AYT', 'KPSS', 'LGS'].every(t => sinavTurleri.has(t));

    return [
        { icon: 'fa-shoe-prints', name: 'İlk Adım', desc: 'İlk net analizini kaydettin', earned: analizCount >= 1 },
        { icon: 'fa-chart-line', name: 'Analist', desc: '5 net analizi kaydettin', earned: analizCount >= 5 },
        { icon: 'fa-chart-column', name: 'Uzman Analist', desc: '15 net analizi kaydettin', earned: analizCount >= 15 },
        { icon: 'fa-medal', name: 'Sınav Ustası', desc: '30 net analizi kaydettin', earned: analizCount >= 30 },
        { icon: 'fa-graduation-cap', name: 'TYT Kaşifi', desc: 'En az bir TYT analizi yaptın', earned: sinavTurleri.has('TYT') },
        { icon: 'fa-flask', name: 'AYT Kaşifi', desc: 'En az bir AYT analizi yaptın', earned: sinavTurleri.has('AYT') },
        { icon: 'fa-landmark', name: 'KPSS Kaşifi', desc: 'En az bir KPSS analizi yaptın', earned: sinavTurleri.has('KPSS') },
        { icon: 'fa-school', name: 'LGS Kaşifi', desc: 'En az bir LGS analizi yaptın', earned: sinavTurleri.has('LGS') },
        { icon: 'fa-star', name: 'Tam Kadro', desc: 'TYT, AYT, KPSS ve LGS\'nin hepsinden analiz yaptın', earned: hepsiVar },
        { icon: 'fa-bolt', name: 'Yüksek Skor', desc: 'Bir analizde 100+ net attın', earned: maxNet >= 100 },
        { icon: 'fa-crown', name: 'Mükemmeliyetçi', desc: 'Bir analizde 110+ net attın', earned: maxNet >= 110 },
        { icon: 'fa-magnifying-glass', name: 'Hatasını Gören', desc: 'İlk yanlış soruyu hata defterine kaydettin', earned: wrongCount >= 1 },
        { icon: 'fa-book-open', name: 'Titiz Öğrenci', desc: '10 yanlış soru kaydettin', earned: wrongCount >= 10 },
        { icon: 'fa-magnet', name: 'Hata Avcısı', desc: '25 yanlış soru kaydettin', earned: wrongCount >= 25 },
        { icon: 'fa-clock', name: 'Odaklanma Başlangıcı', desc: 'İlk pomodoro seansını tamamladın', earned: pomodoroDakika >= 25 },
        { icon: 'fa-stopwatch', name: 'Odak Ustası', desc: 'Toplam 5 saat odaklandın', earned: pomodoroDakika >= 300 },
        { icon: 'fa-fire', name: 'Demir İrade', desc: 'Toplam 20 saat odaklandın', earned: pomodoroDakika >= 1200 },
        { icon: 'fa-person-running', name: 'Maraton Koşucusu', desc: 'Toplam 50 saat odaklandın', earned: pomodoroDakika >= 3000 },
        { icon: 'fa-user-tie', name: 'Koça Bağlandın', desc: 'Bir eğitim koçuna bağlandın', earned: kocSayisi >= 1 },
        { icon: 'fa-paper-plane', name: 'Davetçi', desc: 'İlk arkadaşını davet ettin', earned: referralCount >= 1 },
        { icon: 'fa-people-group', name: 'Topluluk Elçisi', desc: '5 arkadaş davet ettin', earned: referralCount >= 5 },
        { icon: 'fa-certificate', name: 'Premium Üye', desc: "Premium'a yükseldin", earned: isPremium },
        { icon: 'fa-hand-sparkles', name: 'Hoş Geldin', desc: 'SmartStudy ailesine katıldın', earned: true },
        { icon: 'fa-layer-group', name: 'Çok Yönlü', desc: 'Net analizi, hata defteri ve pomodoro\'nun hepsini kullandın', earned: analizCount >= 1 && wrongCount >= 1 && pomodoroDakika >= 1 },
        { icon: 'fa-infinity', name: 'Azimli', desc: '15 saat odaklan + 15 analiz + 15 yanlış soru kaydı', earned: pomodoroDakika >= 900 && analizCount >= 15 && wrongCount >= 15 }
    ];
}

app.get('/profile', requireLogin, async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.redirect('/login');

    const [{ data: analizler }, { data: wrongQuestions }] = await Promise.all([
        supabase.from('analizler').select('*').eq('user_id', user.id),
        supabase.from('wrong_questions').select('*').eq('user_id', user.id)
    ]);

    const pomodoroDakika = Number(user.pomodoro_dakika || 0);
    const kocListesi = user.bagli_koc_listesi || (user.bagli_koc_kodu ? [{ ad: user.bagli_koc_ad || 'Eğitmen' }] : []);

    // Bu özellikten önce kayıt olmuş hesapların referans kodu yok; ilk profil
    // ziyaretinde kendiliğinden bir kod üretip kalıcı olarak kaydediyoruz.
    let referralCode = user.referral_code;
    if (!referralCode) {
        referralCode = 'SS-' + Math.random().toString(36).substr(2, 6).toUpperCase();
        await supabase.from('profiles').update({ referral_code: referralCode }).eq('id', user.id);
    }
    const referralCount = Number(user.referral_count || 0);
    const referralRemaining = 10 - (referralCount % 10);

    const badges = computeBadges({
        analizler: analizler || [],
        wrongCount: (wrongQuestions || []).length,
        pomodoroDakika,
        referralCount,
        kocSayisi: kocListesi.length,
        isPremium: user.level === 'Premium'
    });

    res.render('profile', {
        user,
        analizCount: (analizler || []).length,
        wrongCount: (wrongQuestions || []).length,
        pomodoroDakika,
        kocListesi,
        referralCode,
        referralCount,
        referralRemaining,
        badges
    });
});

// Hesap ayarları artık Profil sayfasından ayrı: kimlik/rozet/istatistikler
// /profile'da, hesap yönetimi (bilgiler, bildirimler, tehlikeli bölge)
// burada. İçerik aynı verilerle çalışıyor, sadece ayrı bir sayfa/rota.
app.get('/ayarlar', requireLogin, async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.redirect('/login');
    res.render('ayarlar', { user });
});

app.post('/profile', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        const ad = String(req.body.ad || '').trim();
        const email = String(req.body.email || '').trim().toLowerCase();
        const newPassword = String(req.body.newPassword || '');

        if (!ad || !email) {
            return res.status(400).send(errorPage('Profil Hatası', 'Girdiğiniz bilgileri kontrol edin.', '/profile'));
        }

        const { data: existing } = await supabase.from('profiles').select('id').eq('email', email).maybeSingle();
        if (existing && existing.id !== user.id) {
            return res.status(409).send(errorPage('Profil Hatası', 'Bu email başka bir hesapta kullanılıyor.', '/profile'));
        }

        // E-posta ve şifre artık Supabase Auth tarafında yönetiliyor (bu
        // ikisi "profiles" tablosunda değil, "auth.users"da tutuluyor).
        const authUpdates = {};
        if (email !== user.email) authUpdates.email = email;
        if (newPassword && newPassword.length >= 8) authUpdates.password = newPassword;
        if (Object.keys(authUpdates).length > 0) {
            const { error: authUpdateError } = await supabase.auth.admin.updateUserById(user.id, authUpdates);
            if (authUpdateError) {
                console.error(authUpdateError);
                return res.status(500).send(errorPage('Hata', 'E-posta/şifre güncellenemedi.', '/profile'));
            }
        }

        await supabase.from('profiles').update({ ad, email }).eq('id', user.id);
        res.redirect('/dashboard');
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Profil güncellenirken bir sorun oluştu.', '/profile'));
    }
});

// Bildirim tercihleri: şu an için sadece kaydediliyor (gerçek e-posta/push
// gönderimi YOK - projede henüz bir e-posta altyapısı kurulmadı). Tercih
// gerçek ve kalıcı; ileride e-posta servisi eklendiğinde doğrudan kullanılabilir.
app.post('/api/update-notifications', requireUser, async (req, res) => {
    try {
        const user = req.currentUser;
        await supabase.from('profiles').update({
            email_notifications: !!req.body.email_notifications,
            study_reminders: !!req.body.study_reminders
        }).eq('id', user.id);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Tercihler kaydedilemedi.' });
    }
});

// Hesap silme: geri alınamaz. Ekstra güvenlik için şifre tekrar isteniyor.
// Kullanıcının kendi verilerini (analizler, hata defteri kayıtları) de
// birlikte siliyor; hesap dokümanı silinip oturum sonlandırılıyor.
app.post('/api/delete-account', requireUser, async (req, res) => {
    try {
        const user = req.currentUser;
        const sifre = String(req.body.password || '');
        // Şifre doğrulaması artık Supabase Auth üzerinden yapılıyor.
        const { error: verifyError } = await supabaseAuthClient.auth.signInWithPassword({ email: user.email, password: sifre });
        if (verifyError) {
            return res.status(401).json({ success: false, message: 'Şifre hatalı.' });
        }

        // auth.users satırını silmek yeterli: profiles (ON DELETE CASCADE ile
        // auth.users'a bağlı) ve ona bağlı analizler/wrong_questions da
        // otomatik olarak zincirleme silinir - ayrıca tek tek silmeye gerek yok.
        const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
        if (deleteError) {
            console.error(deleteError);
            return res.status(500).json({ success: false, message: 'Hesap silinemedi.' });
        }

        req.session.destroy(() => res.json({ success: true }));
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Hesap silinemedi.' });
    }
});

// ==========================================
// 8b. DİJİTAL HATA DEFTERİ (WRONG QUESTIONS) - Web / Bootstrap
// Flutter'daki "Yanlış Sorular" ekranının web panelindeki karşılığı.
// Aynı veriyi (wrong_questions koleksiyonu) ve aynı JSON uçlarını kullanır.
// ==========================================
app.get('/wrong-questions', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user) return res.redirect('/login');

        const { data: questionsRaw } = await supabase.from('wrong_questions').select('*').eq('user_id', user.id);
        const questions = (questionsRaw || []).sort((a, b) => new Date(b.tarih) - new Date(a.tarih));

        const limitReached = user.level !== 'Premium' && questions.length >= 5;

        res.render('wrong-questions', { user, questions, limitReached });
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Hata defteri yüklenirken sorun oluştu.', '/dashboard'));
    }
});

// ==========================================
// 8c. ÖĞRENCİ: KOÇUM & ÖDEVLERİM - Web / Bootstrap
// Flutter'daki "Öğrenci-Koç" ekranının web panelindeki karşılığı.
// ==========================================
app.get('/student-coach', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user) return res.redirect('/login');
        if (user.role !== 'student') return res.redirect('/dashboard');

        const { data: homeworks } = await supabase.from('homeworks').select('*').eq('student_id', user.id);
        const kocListesi = user.bagli_koc_listesi || (user.bagli_koc_kodu ? [{ kod: user.bagli_koc_kodu, ad: user.bagli_koc_ad || 'Eğitmen' }] : []);

        res.render('student-coach', { user, homeworks: homeworks || [], kocListesi });
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Koç bilgisi yüklenirken sorun oluştu.', '/dashboard'));
    }
});
// Eski isim (/my-coach) ile gelen linkler/yer imleri kırılmasın diye yönlendirme.
app.get('/my-coach', requireLogin, (req, res) => res.redirect('/student-coach'));

// ==========================================
// 8d. ŞÖHRETLER SALONU (LEADERBOARD) - Web / Bootstrap
// ==========================================
app.get('/leaderboard', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user) return res.redirect('/login');

        const { data: allStudents } = await supabase.from('profiles').select('*').eq('role', 'student');
        const fullList = (allStudents || [])
            .filter(u => Number(u.en_yuksek_net || 0) > 0)
            .sort((a, b) => Number(b.en_yuksek_net) - Number(a.en_yuksek_net));

        const isPremium = user.level === 'Premium';
        const visibleList = isPremium ? fullList : fullList.slice(0, 5);

        res.render('leaderboard', { user, visibleList, isPremium, fullListLength: fullList.length });
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Liderlik tablosu yüklenirken sorun oluştu.', '/dashboard'));
    }
});

// ==========================================
// 8e. POMODORO ODAKLANMA SİSTEMİ - Web / Bootstrap
// ==========================================
app.get('/pomodoro', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user) return res.redirect('/login');

        res.render('pomodoro', { user });
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Pomodoro sayfası yüklenirken sorun oluştu.', '/dashboard'));
    }
});

app.get('/payment', requireLogin, async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.redirect('/login');

    res.render('payment');
});

app.post('/payment-success', requireLogin, async (req, res) => {
    await supabase.from('profiles').update({ level: 'Premium' }).eq('id', req.session.userId);
    req.session.userLevel = 'Premium';
    res.redirect('/dashboard');
});

app.get('/add-video', requireLogin, async (req, res) => {
    const user = await currentUser(req);
    if (!user || user.role !== 'teacher') return res.redirect('/dashboard');

    res.render('add-video', { user });
});

app.post('/add-video', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user || user.role !== 'teacher') return res.status(403).send('Yetkisiz');

        const { ders, title, teacher, videoId } = req.body;
        if (!ders || !title || !videoId) return res.status(400).send('Eksik bilgi');

        await supabase.from('video_dersler').insert({
            teacher_id: user.id,
            ders,
            title,
            teacher: teacher || user.ad,
            video_id: videoId.trim(),
            tarih: new Date().toISOString()
        });

        res.redirect('/dashboard');
    } catch (e) {
        res.status(500).send('Video eklenirken hata oluştu.');
    }
});

app.get('/premium-dersler', requireLogin, async (req, res) => {
    const user = await currentUser(req);
    if (!user || user.level !== 'Premium') {
        return res.status(403).send(errorPage('Premium Gerekli', 'Bu laboratuvar sadece Premium üyeler içindir.', '/payment'));
    }

    const { data: notlar } = await supabase.from('video_notlari').select('*').eq('user_id', user.id);

    // NOT: Buradaki "SML Hoca / TYT Matematik Genel Tekrar" varsayılan videosu
    // kaldırıldı (talep üzerine).
    const defaultVideos = [
        { id: 'def_2', key: 'turkce', ders: 'Türkçe / Edebiyat', title: 'TYT Türkçe Paragraf Taktikleri', teacher: 'Öznur Saat Yıldırım', videoId: 'CBkWmUCR4K4' },
        { id: 'def_3', key: 'fizik', ders: 'Fizik', title: 'TYT Fizik Genel Tekrar', teacher: 'Fizikfinito', videoId: 'SxwInE8ndkI' },
        { id: 'def_4', key: 'kimya', ders: 'Kimya', title: 'TYT Kimya Genel Tekrar', teacher: 'Meschemy', videoId: '1I-b1UM6ib8' },
        { id: 'def_5', key: 'biyoloji', ders: 'Biyoloji', title: 'TYT Biyoloji Genel Tekrar', teacher: 'Biosem', videoId: 'IOKAsbdHiMc' }
    ];

    const { data: customVidRaw } = await supabase.from('video_dersler').select('*');
    // Şablon (premium-dersler.html) videoId'yi camelCase bekliyor - Postgres
    // sütunu video_id (snake_case) olduğu için burada eşliyoruz.
    const customVideos = (customVidRaw || []).map(v => ({ ...v, key: v.ders, videoId: v.video_id }));

    const videos = [...defaultVideos, ...customVideos].map(video => ({
        ...video,
        notes: (notlar || []).filter(note => note.ders === video.key || note.video_id === video.id)
    }));

    res.render('premium-dersler', { videos, user });
});

app.post('/save-note', requireLogin, async (req, res) => {
    const { ders, videoId, videoTitle, notBaslik, notMetni } = req.body;
    await supabase.from('video_notlari').insert({
        user_id: req.session.userId,
        ders,
        video_id: videoId,
        video_baslik: videoTitle,
        not_baslik: notBaslik || videoTitle,
        not_metni: notMetni,
        tarih: new Date().toISOString()
    });
    res.redirect('/premium-dersler');
});

app.post('/update-note', requireLogin, async (req, res) => {
    await supabase.from('video_notlari').update({
        not_baslik: req.body.notBaslik,
        not_metni: req.body.notMetni
    }).eq('id', req.body.noteId);
    res.redirect('/premium-dersler');
});

app.post('/delete-note', requireLogin, async (req, res) => {
    await supabase.from('video_notlari').delete().eq('id', req.body.noteId);
    res.redirect('/premium-dersler');
});

async function deleteAnalizHandler(req, res) {
    try {
        const user = req.currentUser;
        const analizId = req.body.analizId;
        if (!analizId) {
            if (wantsJson(req)) return res.status(400).json({ success: false, message: 'analizId gerekli.' });
            return res.status(400).send(errorPage('Hata', 'analizId gerekli.', '/dashboard'));
        }

        const { data: analiz } = await supabase.from('analizler').select('user_id').eq('id', analizId).maybeSingle();
        if (!analiz || analiz.user_id !== user.id) {
            if (wantsJson(req)) return res.status(404).json({ success: false, message: 'Analiz bulunamadı.' });
            return res.status(404).send(errorPage('Hata', 'Analiz bulunamadı.', '/dashboard'));
        }

        await supabase.from('analizler').delete().eq('id', analizId);
        if (wantsJson(req)) return res.json({ success: true });
        res.redirect('/dashboard');
    } catch (error) {
        console.error(error);
        if (wantsJson(req)) return res.status(500).json({ success: false, message: 'Analiz silinemedi.' });
        res.status(500).send(errorPage('Hata', 'Analiz silinemedi.', '/dashboard'));
    }
}
// Web (Bootstrap panel) tarafı bu rotayı kullanır.
app.post('/delete-analysis', requireUser, deleteAnalizHandler);
// Flutter (mobil + web) tarafı bu adı kullanıyor; aynı mantığı çalıştırır.
app.post('/delete-analiz', requireUser, deleteAnalizHandler);

app.post('/generate-plan', requireUser, async (req, res) => {
    try {
        const user = req.currentUser;
        let toplamNet = 0;
        const detaylar = {};
        const sinav_turu = req.body.sinav_turu || 'TYT';
        const hedef_net = req.body.hedef ? Number(req.body.hedef) : null;

        for (const [key, value] of Object.entries(req.body)) {
            if (!['sinav_turu', 'role', 'hedef', 'userId', 'is_ai_request'].includes(key)) {
                detaylar[key] = Number(value) || 0;
                toplamNet += detaylar[key];
            }
        }

        const { data: newAnaliz, error: analizError } = await supabase.from('analizler').insert({
            user_id: user.id,
            sinav_turu: sinav_turu,
            hedef_net: hedef_net,
            toplam_net: toplamNet,
            detaylar,
            matematik: detaylar.mat || 0,
            turkce: detaylar.turkce || 0,
            fen: detaylar.fen || 0,
            sosyal: detaylar.sosyal || 0,
            tarih: new Date().toISOString()
        }).select('id').single();
        if (analizError) throw analizError;

        if (wantsJson(req)) return res.status(201).json({ success: true, id: newAnaliz.id, toplam_net: toplamNet });
        res.redirect('/dashboard');
    } catch (error) {
        console.error(error);
        if (wantsJson(req)) return res.status(500).json({ success: false, message: 'Analiz kaydedilemedi.' });
        res.status(500).send(errorPage('Hata', 'Analiz kaydedilemedi.', '/plan'));
    }
});

app.post('/assign-homework', requireUser, async (req, res) => {
    try {
        const user = req.currentUser;
        if (!user || user.role !== 'teacher') {
            if (wantsJson(req)) return res.status(403).json({ success: false, message: 'Sadece öğretmenler ödev verebilir.' });
            return res.status(403).send(errorPage('Yetki Hatası', 'Sadece öğretmenler ödev verebilir.', '/dashboard'));
        }

        let subject = req.body.subject;
        if (user.teacher_type === 'brans') {
            subject = user.branch;
        }

        const { student_id, exam_type } = req.body;
        let assigned_topics = req.body.assigned_topics;

        if (!assigned_topics) {
            if (wantsJson(req)) return res.status(400).json({ success: false, message: 'Lütfen en az bir konu seçimi yapın.' });
            return res.status(400).send(errorPage('Eksik Veri', 'Lütfen en az bir konu seçimi yapın.', '/plan'));
        }
        if (!Array.isArray(assigned_topics)) assigned_topics = [assigned_topics];

        let question_count = parseInt(req.body.question_count, 10);
        if (!Number.isFinite(question_count) || question_count < 1) question_count = null;

        const { data: newHw, error: hwError } = await supabase.from('homeworks').insert({
            teacher_id: user.id,
            student_id: student_id,
            exam_type,
            subject: subject || 'Genel',
            topics: assigned_topics,
            question_count,
            date_assigned: new Date().toISOString(),
            status: 'pending',
            completed: false
        }).select('id').single();
        if (hwError) throw hwError;

        if (wantsJson(req)) return res.status(201).json({ success: true, id: newHw.id });
        res.redirect('/dashboard');
    } catch (error) {
        console.error(error);
        if (wantsJson(req)) return res.status(500).json({ success: false, message: 'Ödev atanamadı.' });
        res.status(500).send(errorPage('Hata', 'Ödev atanamadı.', '/plan'));
    }
});

// ==========================================
// 9. MOBİL / FLUTTER JSON API UÇLARI
// (server.js'de eskiden hiç karşılığı olmayan, Flutter tarafının
// çağırdığı ama backend'de eksik olan rotalar)
// ==========================================

// --- Analiz listesi (Flutter dashboard/pomodoro/profil ekranları) ---
app.get('/api/analizler', async (req, res) => {
    try {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });

        const { data: analizlerRaw } = await supabase.from('analizler').select('*').eq('user_id', user.id);
        // NOT: Eskiden-yeniye (artan) sırayla dönüyor çünkü Flutter tarafı
        // (dashboard_screen.dart) _analizler.first'ü "ilk net", .last'ı
        // "son net" olarak kullanıyor - listenin sonunda en güncel kayıt
        // olmasını bekliyor.
        const analizler = (analizlerRaw || []).sort((a, b) => new Date(a.tarih) - new Date(b.tarih));

        res.json({ success: true, analizler, userLevel: user.level || 'Free' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Analizler alınamadı.' });
    }
});

// --- Dijital Hata Defteri (Wrong Questions) ---
app.get('/api/wrong-questions', async (req, res) => {
    try {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });

        const { data: questionsRaw } = await supabase.from('wrong_questions').select('*').eq('user_id', user.id);
        const questions = (questionsRaw || []).sort((a, b) => new Date(b.tarih) - new Date(a.tarih));

        res.json({ success: true, questions, userLevel: user.level || 'Free' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Sorular alınamadı.' });
    }
});

app.post('/api/wrong-questions/add', async (req, res) => {
    try {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });

        if (user.level !== 'Premium') {
            const { count } = await supabase.from('wrong_questions').select('id', { count: 'exact', head: true }).eq('user_id', user.id);
            if ((count || 0) >= 5) {
                return res.status(403).json({ success: false, message: 'Free üyelikte hata defterine en fazla 5 soru eklenebilir. Premium\'a geçerek sınırsız ekleyebilirsin.' });
            }
        }

        const { question_text, ai_solution, image_base64 } = req.body;
        // İstemci fotoğrafı zaten küçültüp sıkıştırıyor ama yine de bir
        // güvenlik ağı olarak burada da makul bir üst sınır kontrol
        // ediyoruz - aksi halde kullanıcı genel bir 500 hatası görür,
        // sebebini anlayamaz.
        if (image_base64 && image_base64.length > 5000000) {
            return res.status(413).json({ success: false, message: 'Fotoğraf çok büyük. Daha küçük bir fotoğraf dene.' });
        }
        const { data: newQuestion, error: qError } = await supabase.from('wrong_questions').insert({
            user_id: user.id,
            question_text: question_text || 'Hatalı Soru Kaydı',
            ai_solution: ai_solution || '',
            image_base64: image_base64 || '',
            tarih: new Date().toISOString()
        }).select('id').single();
        if (qError) throw qError;

        res.json({ success: true, id: newQuestion.id });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Soru eklenemedi.' });
    }
});

app.post('/api/delete-wrong-question', async (req, res) => {
    try {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });

        const { questionId } = req.body;
        if (!questionId) return res.status(400).json({ success: false, message: 'questionId gerekli.' });

        const { data: question } = await supabase.from('wrong_questions').select('user_id').eq('id', questionId).maybeSingle();
        if (!question || question.user_id !== user.id) {
            return res.status(404).json({ success: false, message: 'Soru bulunamadı.' });
        }

        await supabase.from('wrong_questions').delete().eq('id', questionId);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Soru silinemedi.' });
    }
});

// --- Öğrenci: Koçum & Ödevlerim ---
app.get('/api/student-coach', async (req, res) => {
    try {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });

        let coach = {};
        if (user.bagli_koc_kodu) {
            const { data: c } = await supabase.from('profiles').select('ad, email').eq('role', 'teacher').eq('koc_kodu', user.bagli_koc_kodu).maybeSingle();
            if (c) {
                coach = { ad: c.ad, email: c.email, kod: user.bagli_koc_kodu };
            }
        }

        const { data: hwRaw } = await supabase.from('homeworks').select('*').eq('student_id', user.id);
        const homeworks = (hwRaw || []).map(hw => ({
            id: hw.id,
            subject: hw.subject,
            topic: Array.isArray(hw.topics) ? hw.topics.join(', ') : (hw.topics || ''),
            exam_type: hw.exam_type,
            completed: hw.completed === true || hw.status === 'completed'
        })).sort((a, b) => new Date(b.date_assigned || 0) - new Date(a.date_assigned || 0));

        res.json({ success: true, coach, homeworks });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Koç bilgisi alınamadı.' });
    }
});

app.post('/api/connect-coach', async (req, res) => {
    try {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });
        if (user.role !== 'student') return res.status(403).json({ success: false, message: 'Sadece öğrenciler koça bağlanabilir.' });

        const girilenKod = String(req.body.coachCode || '').trim().toUpperCase();
        if (!girilenKod) return res.status(400).json({ success: false, message: 'Koç kodu gerekli.' });

        const { data: teacher } = await supabase.from('profiles').select('*').eq('role', 'teacher').eq('koc_kodu', girilenKod).maybeSingle();
        if (!teacher) {
            return res.status(404).json({ success: false, message: 'Geçersiz koç kodu.' });
        }

        let kocKodlari = user.bagli_koc_kodlari || [];
        let kocListesi = user.bagli_koc_listesi || [];

        if (!kocKodlari.length && user.bagli_koc_kodu) {
            kocKodlari.push(user.bagli_koc_kodu);
            kocListesi.push({ kod: user.bagli_koc_kodu, ad: user.bagli_koc_ad || 'Eğitmen' });
        }

        if (!kocKodlari.includes(girilenKod)) {
            kocKodlari.push(girilenKod);
            kocListesi.push({ kod: girilenKod, ad: teacher.ad });
        }

        await supabase.from('profiles').update({
            bagli_koc_kodlari: kocKodlari,
            bagli_koc_listesi: kocListesi,
            bagli_koc_kodu: girilenKod,
            bagli_koc_ad: teacher.ad
        }).eq('id', user.id);

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Koç eşleştirmesi yapılamadı.' });
    }
});

// Ödevi sadece o ödevin sahibi öğrenci ya da onu atayan öğretmen
// güncelleyebilir (student_id / teacher_id ile karşılaştırılıyor).
app.post('/api/update-homework', async (req, res) => {
    try {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });

        const { homeworkId, completed } = req.body;
        if (!homeworkId) return res.status(400).json({ success: false, message: 'homeworkId gerekli.' });

        const { data: hw } = await supabase.from('homeworks').select('student_id, teacher_id').eq('id', homeworkId).maybeSingle();
        if (!hw) {
            return res.status(404).json({ success: false, message: 'Ödev bulunamadı.' });
        }
        if (hw.student_id !== user.id && hw.teacher_id !== user.id) {
            return res.status(403).json({ success: false, message: 'Bu ödevi güncelleme yetkiniz yok.' });
        }

        await supabase.from('homeworks').update({
            completed: !!completed,
            status: completed ? 'completed' : 'pending'
        }).eq('id', homeworkId);

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Ödev güncellenemedi.' });
    }
});

// --- Şöhretler Salonu (Leaderboard) ---
app.get('/api/leaderboard', async (req, res) => {
    try {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });

        const { data: allStudents } = await supabase.from('profiles').select('*').eq('role', 'student');
        const leaderboard = (allStudents || [])
            .filter(u => Number(u.en_yuksek_net || 0) > 0)
            .sort((a, b) => Number(b.en_yuksek_net) - Number(a.en_yuksek_net))
            .slice(0, 100)
            .map(u => ({ ad: u.ad, net: Number(u.en_yuksek_net).toFixed(2), is_premium: u.level === 'Premium' }));

        res.json({ success: true, leaderboard, userLevel: user.level || 'Free' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Liderlik tablosu alınamadı.' });
    }
});

app.post('/api/verify-optic-leaderboard', sensitiveActionLimiter, async (req, res) => {
    try {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });

        const { image_base64 } = req.body;
        if (!image_base64) return res.status(400).json({ success: false, message: 'Belge fotoğrafı gerekli.' });

        const verifiedNet = await readNetFromOpticImage(image_base64);
        if (verifiedNet === null) {
            return res.status(503).json({
                success: false,
                message: 'Belge şu anda doğrulanamıyor (yapay zeka servisi yapılandırılmamış ya da belge okunamadı).'
            });
        }

        const currentBest = Number(user.en_yuksek_net || 0);
        if (verifiedNet > currentBest) {
            await supabase.from('profiles').update({
                en_yuksek_net: verifiedNet,
                en_yuksek_net_tarih: new Date().toISOString()
            }).eq('id', user.id);
        }

        res.json({ success: true, verified_net: (verifiedNet > currentBest ? verifiedNet : currentBest).toFixed(2) });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Belge doğrulanırken hata oluştu.' });
    }
});

// --- Pomodoro ---
app.post('/update-pomodoro', async (req, res) => {
    try {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });

        const minutes = Number(req.body.minutes) || 0;
        const newTotal = Number(user.pomodoro_dakika || 0) + minutes;

        await supabase.from('profiles').update({ pomodoro_dakika: newTotal }).eq('id', user.id);
        res.json({ success: true, total_minutes: newTotal });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Pomodoro kaydedilemedi.' });
    }
});

// --- Şifre değiştirme (mobil profil ekranı) ---
app.post('/api/change-password', sensitiveActionLimiter, async (req, res) => {
    try {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });

        const { oldPassword, newPassword } = req.body;
        if (!oldPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Mevcut ve yeni şifre gerekli.' });
        }
        if (String(newPassword).length < 8) {
            return res.status(400).json({ success: false, message: 'Yeni şifre en az 8 karakter olmalı.' });
        }
        const { error: verifyError } = await supabaseAuthClient.auth.signInWithPassword({ email: user.email, password: oldPassword });
        if (verifyError) {
            return res.status(401).json({ success: false, message: 'Mevcut şifre hatalı.' });
        }

        const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, { password: newPassword });
        if (updateError) {
            console.error(updateError);
            return res.status(500).json({ success: false, message: 'Şifre değiştirilemedi.' });
        }
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Şifre değiştirilemedi.' });
    }
});

// --- Premium'a yükseltme (mobil sahte ödeme ekranı, /payment-success'in mobil karşılığı) ---
app.post('/upgrade-premium', async (req, res) => {
    try {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ success: false, message: 'Oturum süresi doldu.' });

        await supabase.from('profiles').update({ level: 'Premium' }).eq('id', user.id);
        if (req.session && req.session.userId === user.id) {
            req.session.userLevel = 'Premium';
        }

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Yükseltme işlemi tamamlanamadı.' });
    }
});

// ==========================================
// 10. DESTEK / İLETİŞİM FORMU
// SSS'te cevap bulamayan ziyaretçiler (giriş yapmış olsun ya da olmasın)
// buradan gerçek bir talep gönderebilir; kayıtlar Firestore'da tutulur.
// ==========================================
app.get('/destek', async (req, res) => {
    const user = await currentUser(req);
    res.render('destek', { user, sent: false });
});

app.post('/destek', sensitiveActionLimiter, async (req, res) => {
    try {
        const user = await currentUser(req);
        const ad = String(req.body.ad || '').trim();
        const email = String(req.body.email || '').trim().toLowerCase();
        const konu = String(req.body.konu || '').trim();
        const mesaj = String(req.body.mesaj || '').trim();

        if (!ad || !email || !mesaj) {
            return res.status(400).render('destek', {
                user,
                sent: false,
                error: 'Ad, e-posta ve mesaj alanları zorunludur.'
            });
        }

        await supabase.from('destek_talepleri').insert({
            ad,
            email,
            konu: konu || 'Genel',
            mesaj,
            user_id: user ? user.id : null,
            tarih: new Date().toISOString(),
            durum: 'yeni'
        });

        res.render('destek', { user, sent: true });
    } catch (error) {
        console.error(error);
        res.status(500).render('destek', {
            user: await currentUser(req),
            sent: false,
            error: 'Talebiniz gönderilirken bir sorun oluştu, lütfen tekrar deneyin.'
        });
    }
});

// ==========================================
// 10. ADMİN PANELİ (SADECE KURUCU)
// ==========================================
// Kim üye olmuş, kaç analiz/hata defteri kaydı girmiş gibi genel bir bakış
// için basit, salt-okunur bir panel. Sadece ADMIN_EMAIL ile eşleşen
// hesaba giriş yapmış kullanıcı görebiliyor - ayrı bir "admin" rolü/kolonu
// eklemeye şimdilik gerek yok, tek yönetici (kurucu) olduğu için.
//
// GİZLİLİK: Kişisel bir e-posta adresini koda (dolayısıyla GitHub'a) hiç
// yazmıyoruz - bu değer SADECE Render'ın Environment sekmesindeki
// ADMIN_EMAIL değişkeninden geliyor. Tanımlı değilse /admin kimseye
// açılmıyor (boş string hiçbir gerçek e-postayla eşleşmez).
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();

async function requireAdmin(req, res, next) {
    const user = await currentUser(req);
    if (!ADMIN_EMAIL || !user || String(user.email || '').toLowerCase() !== ADMIN_EMAIL) {
        return res.status(404).send(errorPage('Sayfa Bulunamadı', 'Aradığınız rota mevcut değil.', '/dashboard'));
    }
    req.currentUser = user;
    next();
}

// Admin panelindeki değişiklikleri kaydediyoruz - "kim, ne zaman, neyi
// değiştirdi" sorusuna cevap verebilmek için. Loglama başarısız olsa bile
// asıl işlemi (silme, seviye değiştirme vb.) engellemesin diye hatasını
// sadece konsola yazıyoruz, isteğe hiç yansıtmıyoruz.
async function logAdminAction(adminEmail, islem, hedefEmail, detay) {
    try {
        await supabase.from('admin_log').insert({ admin_email: adminEmail, islem, hedef_email: hedefEmail || null, detay: detay || null });
    } catch (error) {
        console.error('[ADMIN_LOG]', error);
    }
}

// Admin sayfaları ortak kabuğu - üstte sekme (Kullanıcılar / Destek
// Talepleri / İşlem Kayıtları) navigasyonu olan, koyu temalı basit bir
// yönetim arayüzü.
function adminShell(activeTab, bodyHtml, stats) {
    return `
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Admin Paneli - SmartStudy</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-dark text-white p-4">
        <div class="container-fluid">
            <div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
                <h1 class="h3 m-0"><i class="fas fa-user-shield me-2 text-info"></i>Admin Paneli</h1>
                <a href="/dashboard" class="btn btn-outline-info btn-sm">Panele Dön</a>
            </div>
            ${stats ? `<p class="text-secondary">${stats}</p>` : ''}
            <ul class="nav nav-tabs mb-3 border-secondary">
                <li class="nav-item">
                    <a class="nav-link ${activeTab === 'kullanicilar' ? 'active bg-secondary text-white' : 'text-secondary'}" href="/admin">Kullanıcılar</a>
                </li>
                <li class="nav-item">
                    <a class="nav-link ${activeTab === 'destek' ? 'active bg-secondary text-white' : 'text-secondary'}" href="/admin/destek">Destek Talepleri</a>
                </li>
                <li class="nav-item">
                    <a class="nav-link ${activeTab === 'log' ? 'active bg-secondary text-white' : 'text-secondary'}" href="/admin/log">İşlem Kayıtları</a>
                </li>
            </ul>
            ${bodyHtml}
        </div>
    </body>
    </html>`;
}

app.get('/admin', requireLogin, requireAdmin, async (req, res) => {
    try {
        const [{ data: profiles }, { data: analizler }, { data: wrongQs }] = await Promise.all([
            supabase.from('profiles').select('id, ad, email, role, level, kayit_tarihi').order('kayit_tarihi', { ascending: false }),
            supabase.from('analizler').select('user_id'),
            supabase.from('wrong_questions').select('user_id')
        ]);

        const analizSayaci = {};
        for (const a of (analizler || [])) analizSayaci[a.user_id] = (analizSayaci[a.user_id] || 0) + 1;
        const hataSayaci = {};
        for (const w of (wrongQs || [])) hataSayaci[w.user_id] = (hataSayaci[w.user_id] || 0) + 1;

        const rows = (profiles || []).map(p => {
            const yeniSeviye = p.level === 'Premium' ? 'Free' : 'Premium';
            const yeniRol = p.role === 'teacher' ? 'student' : 'teacher';
            return `
            <tr>
                <td>${escapeHtml(p.ad || '-')}</td>
                <td>${escapeHtml(p.email || '-')}</td>
                <td><span class="badge ${p.role === 'teacher' ? 'bg-warning text-dark' : 'bg-info text-dark'}">${p.role === 'teacher' ? 'Öğretmen' : 'Öğrenci'}</span></td>
                <td><span class="badge ${p.level === 'Premium' ? 'bg-success' : 'bg-secondary'}">${escapeHtml(p.level || 'Free')}</span></td>
                <td>${p.kayit_tarihi ? new Date(p.kayit_tarihi).toLocaleDateString('tr-TR') : '-'}</td>
                <td class="text-center">${analizSayaci[p.id] || 0}</td>
                <td class="text-center">${hataSayaci[p.id] || 0}</td>
                <td class="d-flex flex-wrap gap-1">
                    <form method="POST" action="/admin/set-level">
                        <input type="hidden" name="userId" value="${escapeHtml(p.id)}">
                        <input type="hidden" name="level" value="${yeniSeviye}">
                        <button type="submit" class="btn btn-sm ${yeniSeviye === 'Premium' ? 'btn-success' : 'btn-outline-secondary'}">${yeniSeviye === 'Premium' ? 'Premium Yap' : "Free'ye Düşür"}</button>
                    </form>
                    <form method="POST" action="/admin/set-role">
                        <input type="hidden" name="userId" value="${escapeHtml(p.id)}">
                        <input type="hidden" name="role" value="${yeniRol}">
                        <button type="submit" class="btn btn-sm btn-outline-warning">${yeniRol === 'teacher' ? 'Öğretmen Yap' : 'Öğrenci Yap'}</button>
                    </form>
                    <form method="POST" action="/admin/delete-user" onsubmit="return confirm('${escapeHtml(p.email)} hesabını ve TÜM verilerini (analiz, hata defteri vb.) kalıcı olarak silmek istediğine emin misin? Bu geri alınamaz.');">
                        <input type="hidden" name="userId" value="${escapeHtml(p.id)}">
                        <button type="submit" class="btn btn-sm btn-outline-danger">Sil</button>
                    </form>
                </td>
            </tr>
        `;
        }).join('');

        const body = `
            <div class="table-responsive">
                <table class="table table-dark table-striped table-hover align-middle">
                    <thead>
                        <tr>
                            <th>Ad</th>
                            <th>E-Posta</th>
                            <th>Rol</th>
                            <th>Seviye</th>
                            <th>Kayıt Tarihi</th>
                            <th class="text-center">Analiz Sayısı</th>
                            <th class="text-center">Hata Defteri</th>
                            <th>İşlemler</th>
                        </tr>
                    </thead>
                    <tbody>${rows || '<tr><td colspan="8" class="text-center text-secondary">Henüz kullanıcı yok.</td></tr>'}</tbody>
                </table>
            </div>`;

        res.send(adminShell(
            'kullanicilar',
            body,
            `Toplam kullanıcı: <strong>${(profiles || []).length}</strong> · Toplam analiz: <strong>${(analizler || []).length}</strong> · Toplam hata defteri kaydı: <strong>${(wrongQs || []).length}</strong>`
        ));
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Sunucu Hatası', 'Admin paneli yüklenemedi.', '/dashboard'));
    }
});

app.post('/admin/set-level', requireLogin, requireAdmin, async (req, res) => {
    try {
        const { userId, level } = req.body;
        if (!userId || (level !== 'Free' && level !== 'Premium')) {
            return res.status(400).send(errorPage('Hata', 'Geçersiz istek.', '/admin'));
        }
        const { data: hedef } = await supabase.from('profiles').select('email').eq('id', userId).maybeSingle();
        await supabase.from('profiles').update({ level }).eq('id', userId);
        await logAdminAction(req.currentUser.email, 'Seviye değiştirildi', hedef?.email, `Yeni seviye: ${level}`);
        res.redirect('/admin');
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Sunucu Hatası', 'Seviye güncellenemedi.', '/admin'));
    }
});

app.post('/admin/set-role', requireLogin, requireAdmin, async (req, res) => {
    try {
        const { userId, role } = req.body;
        if (!userId || (role !== 'student' && role !== 'teacher')) {
            return res.status(400).send(errorPage('Hata', 'Geçersiz istek.', '/admin'));
        }
        const { data: hedef } = await supabase.from('profiles').select('email').eq('id', userId).maybeSingle();
        await supabase.from('profiles').update({ role }).eq('id', userId);
        await logAdminAction(req.currentUser.email, 'Rol değiştirildi', hedef?.email, `Yeni rol: ${role}`);
        res.redirect('/admin');
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Sunucu Hatası', 'Rol güncellenemedi.', '/admin'));
    }
});

app.post('/admin/delete-user', requireLogin, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).send(errorPage('Hata', 'Geçersiz istek.', '/admin'));
        }
        const { data: hedef } = await supabase.from('profiles').select('email').eq('id', userId).maybeSingle();
        // auth.users'dan silmek, foreign key cascade sayesinde profiles ve
        // ona bağlı analizler/hata defteri kayıtlarını da otomatik siliyor.
        const { error } = await supabase.auth.admin.deleteUser(userId);
        if (error) console.error(error);
        await logAdminAction(req.currentUser.email, 'Hesap silindi', hedef?.email);
        res.redirect('/admin');
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Sunucu Hatası', 'Kullanıcı silinemedi.', '/admin'));
    }
});

app.get('/admin/destek', requireLogin, requireAdmin, async (req, res) => {
    try {
        const { data: talepler } = await supabase.from('destek_talepleri').select('*').order('tarih', { ascending: false });

        const rows = (talepler || []).map(t => `
            <tr class="${t.durum === 'yeni' ? '' : 'opacity-50'}">
                <td>${t.tarih ? new Date(t.tarih).toLocaleString('tr-TR') : '-'}</td>
                <td>${escapeHtml(t.ad || '-')}</td>
                <td>${escapeHtml(t.email || '-')}</td>
                <td>${escapeHtml(t.konu || '-')}</td>
                <td style="max-width: 380px; white-space: pre-wrap;">${escapeHtml(t.mesaj || '-')}</td>
                <td><span class="badge ${t.durum === 'yeni' ? 'bg-warning text-dark' : 'bg-secondary'}">${escapeHtml(t.durum || 'yeni')}</span></td>
                <td>
                    ${t.durum === 'yeni' ? `
                    <form method="POST" action="/admin/destek/durum">
                        <input type="hidden" name="id" value="${escapeHtml(t.id)}">
                        <input type="hidden" name="durum" value="cozuldu">
                        <button type="submit" class="btn btn-sm btn-outline-success">Çözüldü İşaretle</button>
                    </form>` : ''}
                </td>
            </tr>
        `).join('');

        const body = `
            <div class="table-responsive">
                <table class="table table-dark table-striped align-middle">
                    <thead>
                        <tr>
                            <th>Tarih</th>
                            <th>Ad</th>
                            <th>E-Posta</th>
                            <th>Konu</th>
                            <th>Mesaj</th>
                            <th>Durum</th>
                            <th>İşlem</th>
                        </tr>
                    </thead>
                    <tbody>${rows || '<tr><td colspan="7" class="text-center text-secondary">Henüz destek talebi yok.</td></tr>'}</tbody>
                </table>
            </div>`;

        res.send(adminShell(
            'destek',
            body,
            `Toplam talep: <strong>${(talepler || []).length}</strong> · Yeni: <strong>${(talepler || []).filter(t => t.durum === 'yeni').length}</strong>`
        ));
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Sunucu Hatası', 'Destek talepleri yüklenemedi.', '/dashboard'));
    }
});

app.post('/admin/destek/durum', requireLogin, requireAdmin, async (req, res) => {
    try {
        const { id, durum } = req.body;
        if (!id || !durum) {
            return res.status(400).send(errorPage('Hata', 'Geçersiz istek.', '/admin/destek'));
        }
        const { data: hedef } = await supabase.from('destek_talepleri').select('email').eq('id', id).maybeSingle();
        await supabase.from('destek_talepleri').update({ durum }).eq('id', id);
        await logAdminAction(req.currentUser.email, 'Destek talebi durumu değiştirildi', hedef?.email, `Yeni durum: ${durum}`);
        res.redirect('/admin/destek');
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Sunucu Hatası', 'Durum güncellenemedi.', '/admin/destek'));
    }
});

app.get('/admin/log', requireLogin, requireAdmin, async (req, res) => {
    try {
        const { data: kayitlar } = await supabase.from('admin_log').select('*').order('tarih', { ascending: false }).limit(200);

        const rows = (kayitlar || []).map(k => `
            <tr>
                <td>${k.tarih ? new Date(k.tarih).toLocaleString('tr-TR') : '-'}</td>
                <td>${escapeHtml(k.admin_email)}</td>
                <td>${escapeHtml(k.islem)}</td>
                <td>${escapeHtml(k.hedef_email || '-')}</td>
                <td>${escapeHtml(k.detay || '-')}</td>
            </tr>
        `).join('');

        const body = `
            <div class="table-responsive">
                <table class="table table-dark table-striped align-middle">
                    <thead>
                        <tr>
                            <th>Tarih</th>
                            <th>Admin</th>
                            <th>İşlem</th>
                            <th>Hedef Kullanıcı</th>
                            <th>Detay</th>
                        </tr>
                    </thead>
                    <tbody>${rows || '<tr><td colspan="5" class="text-center text-secondary">Henüz kayıt yok.</td></tr>'}</tbody>
                </table>
            </div>`;

        res.send(adminShell('log', body, `Son 200 işlem gösteriliyor.`));
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Sunucu Hatası', 'İşlem kayıtları yüklenemedi.', '/dashboard'));
    }
});

app.use((req, res) => {
    res.status(404).send(errorPage('Sayfa Bulunamadı', 'Aradığınız rota mevcut değil.', '/dashboard'));
});

app.listen(PORT, () => { 
    console.log(`SmartStudy OS Supabase bağlantısı ile http://localhost:${PORT} adresinde çalışıyor!`); 
});
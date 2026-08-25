
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
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
    origin: ['https://smartstudy-9c6e1.web.app', 'http://localhost:3000', 'http://localhost:5000'],
    credentials: true
}));

// ==========================================
// 1. FIREBASE BAŞLATMA VE MODÜLLER
// ==========================================
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// serviceAccountKey.json bilinçli olarak .gitignore'da (gizli anahtar Git'e
// asla gitmemeli), bu yüzden Render gibi Git'ten deploy eden platformlarda bu
// dosya AKIŞTA HİÇBİR ZAMAN bulunmaz. Eskiden burada doğrudan require()
// yapılıyordu; bu, dosyanın olmadığı her ortamda (yani Render'da) sunucunun
// açılışta çökmesine (MODULE_NOT_FOUND) ve dolayısıyla "API'ye bağlanılamıyor"
// / "oturum süresi doldu" gibi tüm canlı hatalara yol açıyordu. Şimdi önce
// FIREBASE_SERVICE_ACCOUNT ortam değişkenine (Render'da tanımlanacak, JSON
// anahtarının tamamının string hali), yoksa yerel dosyaya bakılıyor.
function loadServiceAccount() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        } catch (e) {
            console.error('[FIREBASE] FIREBASE_SERVICE_ACCOUNT ortam değişkeni geçerli bir JSON değil:', e.message);
        }
    }
    try {
        return require('./serviceAccountKey.json');
    } catch (e) {
        return null;
    }
}

const serviceAccount = loadServiceAccount();
if (!getApps().length) {
    if (serviceAccount) {
        initializeApp({ credential: cert(serviceAccount) });
    } else {
        console.error(
            '[FIREBASE] Servis hesabı bulunamadı! Render\'da FIREBASE_SERVICE_ACCOUNT ortam ' +
            'değişkenini (serviceAccountKey.json dosyasının TÜM içeriği, tek satır JSON olarak) ' +
            'tanımlayın. Aksi halde Firestore\'a bağlanan hiçbir uç çalışmaz.'
        );
    }
}
const db = getFirestore();

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'smartstudy-dev-secret-change-me';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Ortama göre çerez ayarı (Lokalde false, canlıda (Render/Firebase) true ve none olur)
const isProduction = process.env.NODE_ENV === 'production';

app.use(session({
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
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

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
    const doc = await db.collection('users').doc(req.session.userId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
}

// Flutter (mobil + web) istemcisi session çerezi taşımıyor; bunun yerine
// userId'yi doğrudan query/body içinde gönderiyor. Bu fonksiyon önce
// session'a bakar (Bootstrap web arayüzü için), yoksa istekte gelen userId'yi
// Firestore'da doğrulayarak kullanıcıyı döndürür (mobil/stateless istekler
// için). Böylece aynı uç hem tarayıcıdan hem uygulamadan çalışabilir.
async function resolveUser(req) {
    const sessionUser = await currentUser(req);
    if (sessionUser) return sessionUser;

    const explicitId = req.body?.userId || req.query?.userId;
    if (!explicitId) return null;

    const doc = await db.collection('users').doc(String(explicitId)).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
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
            const studentsSnap = await db.collection('users')
                .where('role', '==', 'student')
                .where('bagli_koc_kodu', '==', user.koc_kodu)
                .get();

            teacherData = {
                teacher_type: user.teacher_type || 'koc',
                branch: user.branch || '',
                students: studentsSnap.docs.map(doc => ({ id: doc.id, ad: doc.data().ad, email: doc.data().email }))
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

        const studentsSnap = await db.collection('users')
            .where('role', '==', 'student')
            .where('bagli_koc_kodu', '==', user.koc_kodu)
            .get();

        const students = studentsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        res.json({
            success: true,
            teacher_type: user.teacher_type || 'koc',
            branch: user.branch || '',
            students: students
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

        await db.collection('users').doc(user.id).update({
            teacher_type,
            branch
        });

        res.redirect('/dashboard');
    } catch (e) {
        res.redirect('/teacher-setup');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
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

        if (!ad || !email || sifre.length < 6) {
            const msg = 'Tüm alanları doğru doldurun.';
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

        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('email', '==', email).get();
        if (!snapshot.empty) {
            const msg = 'Bu e-posta sistemde zaten kayıtlı.';
            if (wantsJson(req)) return res.status(409).json({ success: false, message: msg });
            return res.status(409).send(errorPage('Kayıt Hatası', msg, '/register'));
        }

        let kocKodu = null;
        if (role === 'teacher') {
            kocKodu = 'KOC-' + Math.random().toString(36).substr(2, 5).toUpperCase();
        }

        const newUserRef = await usersRef.add({
            role,
            ad,
            email,
            sifre: hashPassword(sifre),
            level: 'Free',
            koc_kodu: kocKodu,
            teacher_type: null,
            branch: null,
            bagli_koc_kodlari: [],
            bagli_koc_listesi: [],
            bagli_koc_kodu: null,
            bagli_koc_ad: null,
            kayit_tarihi: new Date().toISOString(),
            kvkk_onay: kvkkOnayVerildi,
            sozlesme_onay: sozlesmeOnayVerildi,
            onay_tarihi: (kvkkOnayVerildi || sozlesmeOnayVerildi) ? new Date().toISOString() : null
        });

        if (wantsJson(req)) {
            return res.json({ success: true, userId: newUserRef.id, id: newUserRef.id, role });
        }
        res.redirect('/login');
    } catch (error) {
        console.error(error);
        const msg = 'Kayıt işlemi sırasında hata oluştu.';
        if (wantsJson(req)) return res.status(500).json({ success: false, message: msg });
        res.status(500).send(errorPage('Sunucu Hatası', msg, '/register'));
    }
});

app.post('/login', loginLimiter, async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const sifre = String(req.body.sifre || '');
        const requestedRole = req.body.requestedRole; 
        
        const snapshot = await db.collection('users').where('email', '==', email).get();
        if (snapshot.empty) {
            return res.status(401).json({ success: false, message: 'E-Posta veya şifre hatalı.' });
        }

        const userDoc = snapshot.docs[0];
        const user = { id: userDoc.id, ...userDoc.data() };

        if (!verifyPassword(sifre, user.sifre)) {
            return res.status(401).json({ success: false, message: 'E-Posta veya şifre hatalı.' });
        }
        if (requestedRole && user.role !== requestedRole) {
            return res.status(403).json({ success: false, message: `Bu hesaba ${requestedRole === 'teacher' ? 'Eğitmen' : 'Öğrenci'} olarak giriş yapılamaz.` });
        }

        if (!String(user.sifre).startsWith('pbkdf2$')) {
            await db.collection('users').doc(user.id).update({ sifre: hashPassword(sifre) });
        }

        syncSessionUser(req, user);
        res.json({ success: true, role: user.role, userId: user.id, id: user.id, level: user.level || 'Free' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Sunucu bağlantı hatası.' });
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
        const snapshot = await db.collection('users').where('role', '==', 'teacher').where('koc_kodu', '==', girilenKod).get();
        
        if (snapshot.empty) {
            return res.status(404).send(errorPage('Kod Hatası', 'Geçersiz koç kodu girdiniz.', '/dashboard'));
        }

        const teacher = snapshot.docs[0].data();
        const studentDocRef = db.collection('users').doc(user.id);
        const studentData = (await studentDocRef.get()).data();

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

        await studentDocRef.update({ 
            bagli_koc_kodlari: kocKodlari,
            bagli_koc_listesi: kocListesi,
            bagli_koc_kodu: girilenKod, 
            bagli_koc_ad: teacher.ad 
        });

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
        const studentDocRef = db.collection('users').doc(user.id);
        const studentData = (await studentDocRef.get()).data();

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

        await studentDocRef.update(updateData);
        res.redirect('/dashboard');
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Koç bağlantısı kesilemedi.', '/dashboard'));
    }
});

// ==========================================
// 7. KONTROL PANELİ (DASHBOARD)
// ==========================================
app.get('/dashboard', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user) return res.redirect('/login');

        if (user.role === 'teacher' && !user.teacher_type) {
            return res.redirect('/teacher-setup');
        }

        if (user.role === 'teacher') {
            const snap1 = await db.collection('users')
                .where('role', '==', 'student')
                .where('bagli_koc_kodlari', 'array-contains', user.koc_kodu)
                .get();

            const snap2 = await db.collection('users')
                .where('role', '==', 'student')
                .where('bagli_koc_kodu', '==', user.koc_kodu)
                .get();

            const studentMap = new Map();
            snap1.docs.forEach(doc => studentMap.set(doc.id, { id: doc.id, ...doc.data() }));
            snap2.docs.forEach(doc => studentMap.set(doc.id, { id: doc.id, ...doc.data() }));

            const myStudents = [];
            for (const [sId, sData] of studentMap.entries()) {
                const anaSnap = await db.collection('analizler').where('user_id', '==', sId).get();
                const analizler = anaSnap.docs.map(d => d.data()).sort((a,b) => new Date(b.tarih) - new Date(a.tarih));
                const sonNet = analizler.length > 0 ? Number(analizler[0].toplam_net).toFixed(2) : '0.00';
                
                myStudents.push({ 
                    id: sId, 
                    ad: sData.ad, 
                    email: sData.email, 
                    analizSayisi: analizler.length, 
                    sonNet: sonNet 
                });
            }

            const hwSnapshot = await db.collection('homeworks').where('teacher_id', '==', user.id).get();
            const myAssignedHomeworks = hwSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            const roleBadgeText = user.teacher_type === 'brans' ? `Branş Öğretmeni (${user.branch})` : 'Eğitim Koçu (Genel)';
            const hasNoStudents = myStudents.length === 0;

            res.render('dashboard-teacher', { user, roleBadgeText, myStudents, myAssignedHomeworks, hasNoStudents });
        } else {
            const analizSnapshot = await db.collection('analizler').where('user_id', '==', user.id).get();
            const analizler = analizSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a,b) => new Date(b.tarih) - new Date(a.tarih));
            
            const analizlerByExam = {};
            analizler.forEach(a => {
                const type = a.sinav_turu || 'Genel';
                if (!analizlerByExam[type]) analizlerByExam[type] = [];
                analizlerByExam[type].push(a);
            });

            let examTypes = Object.keys(analizlerByExam);
            if (examTypes.length === 0) examTypes = ['Genel'];

            const kocListesi = user.bagli_koc_listesi || (user.bagli_koc_kodu ? [{ kod: user.bagli_koc_kodu, ad: user.bagli_koc_ad || 'Eğitmen' }] : []);

            res.render('dashboard-student', { user, examTypes, analizlerByExam, kocListesi, buildDailyTasks });
        }
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Dashboard yüklenirken sorun oluştu.'));
    }
});

// ==========================================
// 8. PROFİL, ÖDEME VE VİDEO LABORATUVARI
// ==========================================
app.get('/profile', requireLogin, async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.redirect('/login');

    const [analizSnap, wrongSnap] = await Promise.all([
        db.collection('analizler').where('user_id', '==', user.id).get(),
        db.collection('wrong_questions').where('user_id', '==', user.id).get()
    ]);

    const pomodoroDakika = Number(user.pomodoro_dakika || 0);
    const kocListesi = user.bagli_koc_listesi || (user.bagli_koc_kodu ? [{ ad: user.bagli_koc_ad || 'Eğitmen' }] : []);

    res.render('profile', {
        user,
        analizCount: analizSnap.size,
        wrongCount: wrongSnap.size,
        pomodoroDakika,
        kocListesi
    });
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

        const snapshot = await db.collection('users').where('email', '==', email).get();
        if (!snapshot.empty && snapshot.docs[0].id !== user.id) {
            return res.status(409).send(errorPage('Profil Hatası', 'Bu email başka bir hesapta kullanılıyor.', '/profile'));
        }

        const updates = { ad, email };
        if (newPassword && newPassword.length >= 6) {
            updates.sifre = hashPassword(newPassword);
        }

        await db.collection('users').doc(user.id).update(updates);
        res.redirect('/dashboard');
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Profil güncellenirken bir sorun oluştu.', '/profile'));
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

        const snap = await db.collection('wrong_questions').where('user_id', '==', user.id).get();
        const questions = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => new Date(b.tarih) - new Date(a.tarih));

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

        const hwSnap = await db.collection('homeworks').where('student_id', '==', user.id).get();
        const homeworks = hwSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const kocListesi = user.bagli_koc_listesi || (user.bagli_koc_kodu ? [{ kod: user.bagli_koc_kodu, ad: user.bagli_koc_ad || 'Eğitmen' }] : []);

        res.render('student-coach', { homeworks, kocListesi });
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

        const snap = await db.collection('users').where('role', '==', 'student').get();
        const fullList = snap.docs.map(d => d.data())
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
    await db.collection('users').doc(req.session.userId).update({ level: 'Premium' });
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

        await db.collection('video_dersler').add({
            teacher_id: user.id,
            ders,
            title,
            teacher: teacher || user.ad,
            videoId: videoId.trim(),
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

    const notlarSnap = await db.collection('video_notlari').where('user_id', '==', user.id).get();
    const notlar = notlarSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // NOT: Buradaki "SML Hoca / TYT Matematik Genel Tekrar" varsayılan videosu
    // kaldırıldı (talep üzerine).
    const defaultVideos = [
        { id: 'def_2', key: 'turkce', ders: 'Türkçe / Edebiyat', title: 'TYT Türkçe Paragraf Taktikleri', teacher: 'Öznur Saat Yıldırım', videoId: 'CBkWmUCR4K4' },
        { id: 'def_3', key: 'fizik', ders: 'Fizik', title: 'TYT Fizik Genel Tekrar', teacher: 'Fizikfinito', videoId: 'SxwInE8ndkI' },
        { id: 'def_4', key: 'kimya', ders: 'Kimya', title: 'TYT Kimya Genel Tekrar', teacher: 'Meschemy', videoId: '1I-b1UM6ib8' },
        { id: 'def_5', key: 'biyoloji', ders: 'Biyoloji', title: 'TYT Biyoloji Genel Tekrar', teacher: 'Biosem', videoId: 'IOKAsbdHiMc' }
    ];

    const customVidSnap = await db.collection('video_dersler').get();
    const customVideos = customVidSnap.docs.map(d => ({ id: d.id, key: d.data().ders, ...d.data() }));

    const videos = [...defaultVideos, ...customVideos].map(video => ({
        ...video,
        notes: notlar.filter(note => note.ders === video.key || note.video_id === video.id)
    }));

    res.render('premium-dersler', { videos });
});

app.post('/save-note', requireLogin, async (req, res) => {
    const { ders, videoId, videoTitle, notBaslik, notMetni } = req.body;
    await db.collection('video_notlari').add({ 
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
    await db.collection('video_notlari').doc(req.body.noteId).update({ 
        not_baslik: req.body.notBaslik, 
        not_metni: req.body.notMetni, 
        guncelleme_tarihi: new Date().toISOString() 
    });
    res.redirect('/premium-dersler');
});

app.post('/delete-note', requireLogin, async (req, res) => {
    await db.collection('video_notlari').doc(req.body.noteId).delete();
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

        const ref = db.collection('analizler').doc(analizId);
        const doc = await ref.get();
        if (!doc.exists || doc.data().user_id !== user.id) {
            if (wantsJson(req)) return res.status(404).json({ success: false, message: 'Analiz bulunamadı.' });
            return res.status(404).send(errorPage('Hata', 'Analiz bulunamadı.', '/dashboard'));
        }

        await ref.delete();
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

        const docRef = await db.collection('analizler').add({
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
        });

        if (wantsJson(req)) return res.status(201).json({ success: true, id: docRef.id, toplam_net: toplamNet });
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

        const hwRef = await db.collection('homeworks').add({
            teacher_id: user.id,
            student_id: student_id,
            exam_type,
            subject: subject || 'Genel',
            topics: assigned_topics,
            date_assigned: new Date().toISOString(),
            status: 'pending',
            completed: false
        });

        if (wantsJson(req)) return res.status(201).json({ success: true, id: hwRef.id });
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

        const snap = await db.collection('analizler').where('user_id', '==', user.id).get();
        const analizler = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => new Date(b.tarih) - new Date(a.tarih));

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

        const snap = await db.collection('wrong_questions').where('user_id', '==', user.id).get();
        const questions = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => new Date(b.tarih) - new Date(a.tarih));

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
            const existing = await db.collection('wrong_questions').where('user_id', '==', user.id).get();
            if (existing.size >= 5) {
                return res.status(403).json({ success: false, message: 'Free üyelikte hata defterine en fazla 5 soru eklenebilir. Premium\'a geçerek sınırsız ekleyebilirsin.' });
            }
        }

        const { question_text, ai_solution, image_base64 } = req.body;
        const docRef = await db.collection('wrong_questions').add({
            user_id: user.id,
            question_text: question_text || 'Hatalı Soru Kaydı',
            ai_solution: ai_solution || '',
            image_base64: image_base64 || '',
            tarih: new Date().toISOString()
        });

        res.json({ success: true, id: docRef.id });
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

        const ref = db.collection('wrong_questions').doc(questionId);
        const doc = await ref.get();
        if (!doc.exists || doc.data().user_id !== user.id) {
            return res.status(404).json({ success: false, message: 'Soru bulunamadı.' });
        }

        await ref.delete();
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
            const coachSnap = await db.collection('users')
                .where('role', '==', 'teacher')
                .where('koc_kodu', '==', user.bagli_koc_kodu)
                .limit(1)
                .get();
            if (!coachSnap.empty) {
                const c = coachSnap.docs[0].data();
                coach = { ad: c.ad, email: c.email, kod: user.bagli_koc_kodu };
            }
        }

        const hwSnap = await db.collection('homeworks').where('student_id', '==', user.id).get();
        const homeworks = hwSnap.docs.map(d => {
            const hw = d.data();
            return {
                id: d.id,
                subject: hw.subject,
                topic: Array.isArray(hw.topics) ? hw.topics.join(', ') : (hw.topics || ''),
                exam_type: hw.exam_type,
                completed: hw.completed === true || hw.status === 'completed'
            };
        }).sort((a, b) => new Date(b.date_assigned || 0) - new Date(a.date_assigned || 0));

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

        const snapshot = await db.collection('users').where('role', '==', 'teacher').where('koc_kodu', '==', girilenKod).get();
        if (snapshot.empty) {
            return res.status(404).json({ success: false, message: 'Geçersiz koç kodu.' });
        }

        const teacher = snapshot.docs[0].data();
        const studentDocRef = db.collection('users').doc(user.id);

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

        await studentDocRef.update({
            bagli_koc_kodlari: kocKodlari,
            bagli_koc_listesi: kocListesi,
            bagli_koc_kodu: girilenKod,
            bagli_koc_ad: teacher.ad
        });

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

        const ref = db.collection('homeworks').doc(homeworkId);
        const doc = await ref.get();
        if (!doc.exists) {
            return res.status(404).json({ success: false, message: 'Ödev bulunamadı.' });
        }
        const hw = doc.data();
        if (hw.student_id !== user.id && hw.teacher_id !== user.id) {
            return res.status(403).json({ success: false, message: 'Bu ödevi güncelleme yetkiniz yok.' });
        }

        await ref.update({
            completed: !!completed,
            status: completed ? 'completed' : 'pending'
        });

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

        const snap = await db.collection('users').where('role', '==', 'student').get();
        const leaderboard = snap.docs
            .map(d => d.data())
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
            await db.collection('users').doc(user.id).update({
                en_yuksek_net: verifiedNet,
                en_yuksek_net_tarih: new Date().toISOString()
            });
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

        await db.collection('users').doc(user.id).update({ pomodoro_dakika: newTotal });
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
        if (String(newPassword).length < 6) {
            return res.status(400).json({ success: false, message: 'Yeni şifre en az 6 karakter olmalı.' });
        }
        if (!verifyPassword(oldPassword, user.sifre)) {
            return res.status(401).json({ success: false, message: 'Mevcut şifre hatalı.' });
        }

        await db.collection('users').doc(user.id).update({ sifre: hashPassword(newPassword) });
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

        await db.collection('users').doc(user.id).update({ level: 'Premium' });
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

        await db.collection('destek_talepleri').add({
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

app.use((req, res) => {
    res.status(404).send(errorPage('Sayfa Bulunamadı', 'Aradığınız rota mevcut değil.', '/dashboard')); 
});

app.listen(PORT, () => { 
    console.log(`SmartStudy OS Firebase bağlantısı ile http://localhost:${PORT} adresinde çalışıyor!`); 
});
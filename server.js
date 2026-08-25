
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// ==========================================
// 0. CORS VE GÜVENLİK AYARLARI (GÜNCELLENDİ)
// ==========================================
app.use(cors({
    origin: ['https://smartstudy-9c6e1.web.app', 'http://localhost:3000'],
    credentials: true
}));

// ==========================================
// 1. FIREBASE BAŞLATMA VE MODÜLLER
// ==========================================
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = require('./serviceAccountKey.json');
if (!getApps().length) {
    initializeApp({
        credential: cert(serviceAccount)
    });
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
async function requireLogin(req, res, next) {
    if (!req.session.userId) {
        if (req.headers['content-type'] === 'application/json' || req.xhr || req.headers.accept?.includes('json')) {
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
    const user = await currentUser(req);
    if (user && user.role === 'teacher' && !user.teacher_type) {
        return res.redirect('/teacher-setup');
    }
    sendPage(res, 'plan.html');
});

// EĞİTMEN VERİ API
app.get('/api/teacher-data', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
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

        res.send(`
        <!DOCTYPE html>
        <html lang="tr">
        <head>
            <meta charset="UTF-8">
            <title>Eğitmen Profil Kurulumu</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
            <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Inter:wght@300;500;700&display=swap" rel="stylesheet">
            <style>
                body { background: #020617; color: white; font-family: 'Inter', sans-serif; height: 100vh; display: flex; align-items: center; justify-content: center; }
                .setup-card { background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(13, 202, 240, 0.3); border-radius: 20px; padding: 40px; width: 450px; box-shadow: 0 15px 35px rgba(0,0,0,0.5); }
                .form-control, .form-select { background: #0f172a; border: 1px solid #334155; color: white !important; padding: 12px; }
            </style>
        </head>
        <body>
            <div class="setup-card">
                <h3 class="text-warning orbitron mb-3 text-center">Eğitmen Rol Kurulumu</h3>
                <p class="text-secondary small text-center mb-4">Sistemi nasıl kullanacağınızı belirleyin. Bu ayar daha sonra değiştirilemez.</p>
                <form action="/teacher-setup" method="POST">
                    <div class="mb-3">
                        <label class="form-label text-info fw-bold">Eğitmen Türü</label>
                        <select name="teacher_type" class="form-select" id="tType" onchange="toggleBranch()" required>
                            <option value="koc">Eğitim Koçu (Tüm Derslere ve Konulara Erişim)</option>
                            <option value="brans">Branş Öğretmeni (Yalnızca Kendi Branşı)</option>
                        </select>
                    </div>
                    <div class="mb-4" id="branchDiv" style="display:none;">
                        <label class="form-label text-success fw-bold">Branşınız / Dersiniz</label>
                        <select name="branch" class="form-select">
                            <option value="Türkçe / Türk Dili ve Edebiyatı">Türkçe / Türk Dili ve Edebiyatı</option>
                            <option value="Matematik">Matematik</option>
                            <option value="Geometri">Geometri</option>
                            <option value="Fizik">Fizik</option>
                            <option value="Kimya">Kimya</option>
                            <option value="Biyoloji">Biyoloji</option>
                            <option value="Tarih">Tarih</option>
                            <option value="Coğrafya">Coğrafya</option>
                            <option value="Vatandaşlık">Vatandaşlık</option>
                        </select>
                    </div>
                    <button class="btn btn-warning w-100 fw-bold py-3 orbitron">Seçimi Kaydet ve Başla</button>
                </form>
            </div>
            <script>
                function toggleBranch() {
                    const val = document.getElementById('tType').value;
                    document.getElementById('branchDiv').style.display = (val === 'brans') ? 'block' : 'none';
                }
            </script>
        </body>
        </html>`);
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
app.post('/register', async (req, res) => {
    try {
        const ad = String(req.body.ad || '').trim();
        const email = String(req.body.email || '').trim().toLowerCase();
        const sifre = String(req.body.sifre || '');
        const role = req.body.role === 'teacher' ? 'teacher' : 'student';

        if (!ad || !email || sifre.length < 6) {
            return res.status(400).send(errorPage('Kayıt Hatası', 'Tüm alanları doğru doldurun.', '/register'));
        }

        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('email', '==', email).get();
        if (!snapshot.empty) {
            return res.status(409).send(errorPage('Kayıt Hatası', 'Bu e-posta sistemde zaten kayıtlı.', '/register'));
        }

        let kocKodu = null;
        if (role === 'teacher') {
            kocKodu = 'KOC-' + Math.random().toString(36).substr(2, 5).toUpperCase();
        }

        await usersRef.add({
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
            kayit_tarihi: new Date().toISOString()
        });
        res.redirect('/login');
    } catch (error) {
        console.error(error);
        res.status(500).send(errorPage('Sunucu Hatası', 'Kayıt işlemi sırasında hata oluştu.', '/register'));
    }
});

app.post('/login', async (req, res) => {
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
        res.json({ success: true, role: user.role });
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

        const cssTheme = `
        <style>
            :root { --bg-deep: #020617; --card-glass: rgba(30, 41, 59, 0.72); --accent-blue: #0dcaf0; --accent-warning: #ffc107; }
            body { background: var(--bg-deep); color: white; font-family: 'Inter', sans-serif; }
            .orbitron { font-family: 'Orbitron', sans-serif; }
            .glass { background: var(--card-glass); border: 1px solid rgba(13,202,240,0.22); border-radius: 14px; padding: 24px; }
            .sidebar-link { display: block; padding: 12px 16px; color: #94a3b8; text-decoration: none; border-radius: 10px; margin-bottom: 6px; transition: 0.3s; }
            .sidebar-link:hover, .sidebar-link.active { background: rgba(13,202,240,0.10); color: #0dcaf0; }
            .target-bar { height: 12px; background: #0f172a; border-radius: 999px; overflow: hidden; }
            .target-bar span { display: block; height: 100%; background: #ffc107; }
            canvas { max-height: 280px; }
            .nav-pills .nav-link { color: #94a3b8; border: 1px solid rgba(13,202,240,0.2) !important; background: transparent; border-radius: 8px; transition: 0.3s; }
            .nav-pills .nav-link:hover { color: #0dcaf0; border-color: rgba(13,202,240,0.5) !important; }
            .nav-pills .nav-link.active { background: rgba(13,202,240,0.15) !important; color: #0dcaf0 !important; border-color: #0dcaf0 !important; font-weight: bold; }
        </style>`;

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

            let studentListHTML = myStudents.map(s => `
                <tr>
                    <td><strong>${escapeHtml(s.ad)}</strong></td>
                    <td>${escapeHtml(s.email)}</td>
                    <td><span class="badge bg-info text-dark">${s.analizSayisi} Adet</span></td>
                    <td class="text-warning fw-bold">${s.sonNet} Net</td>
                </tr>
            `).join('');

            if (!studentListHTML) {
                studentListHTML = '<tr><td colspan="4" class="text-center text-secondary py-4">Henüz koç kodunuzu girerek sizinle eşleşen bir öğrenci bulunmuyor.</td></tr>';
            }

            let hwListHTML = myAssignedHomeworks.map(hw => `
                <li class="mb-2 text-secondary">
                    <i class="fas fa-check-circle text-info me-2"></i><strong>Öğrenci ID (${hw.student_id}):</strong> 
                    ${hw.exam_type} - ${hw.subject} (${hw.topics.join(', ')})
                </li>
            `).join('');

            if (!hwListHTML) {
                hwListHTML = '<li class="text-secondary small">Henüz öğrencilere ödev ataması yapmadınız.</li>';
            }

            const roleBadgeText = user.teacher_type === 'brans' ? `Branş Öğretmeni (${user.branch})` : 'Eğitim Koçu (Genel)';
            const hasNoStudents = myStudents.length === 0;
            const assignBtnClass = hasNoStudents ? 'btn btn-info fw-bold mb-4 orbitron text-dark opacity-50 pointer-events-none' : 'btn btn-info fw-bold mb-4 orbitron text-dark';
            const assignBtnTitle = hasNoStudents ? 'title="Eşleşen öğrenciniz olmadığı için ödev atayamazsınız"' : '';

            res.send(`
            <!DOCTYPE html>
            <html lang="tr">
            <head>
                <meta charset="UTF-8">
                <title>Eğitmen Paneli</title>
                <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Inter:wght@300;500;700&display=swap" rel="stylesheet">
                <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
                ${cssTheme}
            </head>
            <body>
                <nav class="navbar navbar-expand-lg sticky-top p-3" style="background: rgba(15,23,42,0.8); border-bottom: 1px solid rgba(13,202,240,0.15);">
                    <div class="container-fluid">
                        <a class="navbar-brand orbitron fw-bold text-info" href="#"><i class="fas fa-microchip me-2"></i>SMARTSTUDY OS</a>
                        <div class="ms-auto d-flex align-items-center">
                            <span class="badge bg-warning text-dark me-3 border border-warning px-3 py-2 orbitron">${roleBadgeText}</span>
                            <a href="/logout" class="btn btn-outline-danger btn-sm orbitron" style="font-size: 0.75rem;"><i class="fas fa-power-off me-1"></i> Çıkış</a>
                        </div>
                    </div>
                </nav>
                <div class="container py-5">
                    <div class="glass mb-4" style="border-color: #ffc107;">
                        <h4 class="orbitron text-warning mb-3">Hoş Geldin, Eğitmen ${escapeHtml(user.ad)}</h4>
                        <div class="alert alert-dark border border-warning text-white mb-4">
                            <i class="fas fa-key text-warning me-2"></i> <strong>Sizin Koç Kodunuz:</strong> <span class="text-warning fs-5 ms-2 orbitron">${escapeHtml(user.koc_kodu)}</span>
                            <p class="small text-secondary mt-2 mb-0">Öğrencilerinize bu kodu vererek sistem üzerinde doğrudan sizinle eşleşmelerini sağlayabilirsiniz.</p>
                        </div>
                        <a href="/plan" class="${assignBtnClass}" ${assignBtnTitle}><i class="fas fa-plus me-2"></i>Öğrencilere Ödev Atama Terminali</a>
                        <a href="/add-video" class="btn btn-warning fw-bold mb-4 ms-2 orbitron text-dark"><i class="fas fa-video me-2"></i>Laboratuvara Video Ekle</a>
                        ${hasNoStudents ? '<p class="text-warning small mb-3"><i class="fas fa-exclamation-triangle me-1"></i> Ödev atayabilmek için en az bir öğrencinin koç kodunuzla sizinle eşleşmesi gereklidir.</p>' : ''}

                        <h5 class="orbitron text-info mt-4 mb-3"><i class="fas fa-users me-2"></i>Eşleşen Öğrencileriniz (${myStudents.length})</h5>
                        <div class="table-responsive mb-4">
                            <table class="table table-dark table-hover text-center align-middle">
                                <thead>
                                    <tr><th>Öğrenci Adı</th><th>E-Posta</th><th>Toplam Analiz</th><th>Son Net Durumu</th></tr>
                                </thead>
                                <tbody>
                                    ${studentListHTML}
                                </tbody>
                            </table>
                        </div>

                        <h6 class="orbitron text-light mt-4 border-bottom border-secondary pb-2">Atadığınız Son Ödevler (${myAssignedHomeworks.length})</h6>
                        <ul class="list-unstyled mt-3">${hwListHTML}</ul>
                    </div>
                </div>
            </body>
            </html>`);
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

            const hwSnapshot = await db.collection('homeworks').where('student_id', '==', user.id).get(); 
            const myHomeworks = hwSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            let hwListHTML = myHomeworks.map(hw => `<li class="text-white mb-2"><i class="fas fa-book-open text-warning me-2"></i><strong>${hw.exam_type} - ${hw.subject}:</strong> <span class="text-info">${hw.topics.join(', ')}</span></li>`).join('');
            if (!hwListHTML) hwListHTML = '<li class="text-white-50">Sana atanmış bir ödev yok.</li>';

            let coachListHTML = '';
            const kocListesi = user.bagli_koc_listesi || (user.bagli_koc_kodu ? [{ kod: user.bagli_koc_kodu, ad: user.bagli_koc_ad || 'Eğitmen' }] : []);

            if (kocListesi.length > 0) {
                coachListHTML = kocListesi.map(c => `
                    <div class="d-flex justify-content-between align-items-center mb-2 pb-2 border-bottom border-secondary">
                        <div>
                            <i class="fas fa-check-circle text-success me-1"></i> <strong>${escapeHtml(c.ad)}</strong> 
                            <span class="text-secondary small ms-1">(${escapeHtml(c.kod)})</span>
                        </div>
                        <form action="/remove-coach" method="POST" class="m-0">
                            <input type="hidden" name="coachCode" value="${escapeHtml(c.kod)}">
                            <button class="btn btn-sm btn-outline-danger py-0 px-2" title="Bu Koçtan Ayrıl"><i class="fas fa-times"></i></button>
                        </form>
                    </div>
                `).join('');
            } else {
                coachListHTML = '<p class="text-white small mb-3">Henüz bir eğitmene bağlı değilsin.</p>';
            }

            let coachHTML = `
            <h6 class="text-warning mb-3 orbitron"><i class="fas fa-user-tie me-2"></i>Eğitim Koçlarım (${kocListesi.length})</h6>
            ${coachListHTML}
            <p class="text-secondary small mt-3 mb-2">Başka bir koçla eşleşmek için kod gir:</p>
            <form action="/set-coach" method="POST" class="d-flex gap-2">
                <input type="text" name="coachCode" class="form-control form-control-sm bg-dark text-warning border-warning" placeholder="KOC-XXXXX" required>
                <button type="submit" class="btn btn-warning btn-sm fw-bold">Ekle</button>
            </form>`;

            let premiumLockHTML = '';
            if (user.level !== 'Premium') {
                premiumLockHTML = `
                <div class="glass h-100" style="border-color:#ffc107; position:relative; overflow:hidden;">
                    <div style="filter:blur(3px); opacity:0.4;">
                        <h5 class="text-warning">Premium Laboratuvar</h5>
                        <p class="small text-white">TYT Matematik, Paragraf Taktikleri, Video Dersleri...</p>
                    </div>
                    <div style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); text-align:center; width:100%;">
                        <a href="/payment" class="btn btn-warning fw-bold orbitron text-dark">Premium'a Geç <i class="fas fa-lock-open ms-1"></i></a>
                    </div>
                </div>`;
            } else {
                premiumLockHTML = `
                <div class="glass h-100" style="border-color: #ffc107;">
                    <h5 class="text-warning mb-3"><i class="fas fa-crown me-2"></i>Premium Modül</h5>
                    <p class="small text-white-50">Tüm video dersler ve özel not alma laboratuvarınız aktif.</p>
                    <a href="/premium-dersler" class="btn btn-warning w-100 orbitron text-dark fw-bold mt-2">Derslere Git</a>
                </div>`;
            }

            const tabsNavHTML = `
                <ul class="nav nav-pills mb-4" id="examTabs" role="tablist">
                    ${examTypes.map((type, i) => `
                        <li class="nav-item" role="presentation">
                            <button class="nav-link orbitron ${i===0 ? 'active' : ''} px-4 me-2" id="tab-${type}" data-bs-toggle="pill" data-bs-target="#pane-${type}" type="button" role="tab">${type} PANELİ</button>
                        </li>
                    `).join('')}
                </ul>
            `;

            let chartScript = '<script>const charts = {};\n';
            const tabsContentHTML = `
                <div class="tab-content" id="examTabsContent">
                    ${examTypes.map((type, i) => {
                        const typeAnalizler = analizlerByExam[type] || [];
                        const typeChartAnalizler = [...typeAnalizler].reverse();
                        const tToplam = typeAnalizler.length;
                        const tSonNet = tToplam > 0 ? Number(typeAnalizler[0].toplam_net).toFixed(2) : '0.00';
                        const tGelisim = tToplam > 1 ? (Number(typeAnalizler[0].toplam_net) - Number(typeAnalizler[1].toplam_net)).toFixed(2) : '0.00';
                        
                        const tHedef = (tToplam > 0 && typeAnalizler[0].hedef_net) ? Number(typeAnalizler[0].hedef_net) : null;
                        let tKalan = "-";
                        let tTamamlanma = 0;
                        let hedefMetni = `${type} Hedefi`;

                        if (tToplam === 0 || !tHedef) {
                            tKalan = `<span class="fs-6 text-secondary">Bekleniyor</span>`;
                        } else {
                            const kalan = Math.max(0, tHedef - Number(tSonNet));
                            tKalan = kalan.toFixed(2);
                            tTamamlanma = Math.min(100, (Number(tSonNet) / tHedef) * 100).toFixed(0);
                            hedefMetni = `${type} Hedefine Kalan`;
                        }

                        const tTasks = buildDailyTasks(typeAnalizler[0]).map(task => `<li>${escapeHtml(task)}</li>`).join('');
                        let chartAreaHTML = tToplam > 0 ? `<div style="position:relative; height:250px; width:100%;"><canvas id="chart-${type}"></canvas></div>` : `<div class="text-center text-secondary py-5">Grafik için ${type} analizi girmelisiniz.</div>`;
                        let tableRows = tToplam > 0 ? typeAnalizler.map(a => `<tr><td>${escapeHtml(new Date(a.tarih).toLocaleDateString('tr-TR'))}</td><td>${escapeHtml(a.matematik)}</td><td>${escapeHtml(a.turkce)}</td><td>${escapeHtml(a.fen)}</td><td>${escapeHtml(a.sosyal)}</td><td class="text-info fw-bold">${escapeHtml(Number(a.toplam_net).toFixed(2))}</td><td><form action="/delete-analysis" method="POST" class="m-0"><input type="hidden" name="analizId" value="${a.id}"><button class="btn btn-sm btn-outline-danger py-0"><i class="fas fa-trash small"></i></button></form></td></tr>`).join('') : `<tr><td colspan="7" class="text-center text-secondary py-4">Henüz analiz yok.</td></tr>`;

                        if (tToplam > 0) {
                            const cLabels = typeChartAnalizler.map(a => new Date(a.tarih).toLocaleDateString('tr-TR'));
                            const cData = typeChartAnalizler.map(a => Number(a.toplam_net || 0));
                            chartScript += `
                                setTimeout(() => {
                                    const ctx_${type} = document.getElementById('chart-${type}');
                                    if(ctx_${type}) {
                                        charts['${type}'] = new Chart(ctx_${type}, {
                                            type: 'line',
                                            data: {
                                                labels: ${JSON.stringify(cLabels)},
                                                datasets: [{ label: '${type} Toplam Net', data: ${JSON.stringify(cData)}, borderColor: '#0dcaf0', backgroundColor: 'rgba(13,202,240,0.1)', tension: 0.4, fill: true }]
                                            },
                                            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' } }, x: { grid: { color: 'rgba(255,255,255,0.05)' } } } }
                                        });
                                    }
                                }, 150);
                            `;
                        }

                        return `
                        <div class="tab-pane fade ${i===0 ? 'show active' : ''}" id="pane-${type}" role="tabpanel" tabindex="0">
                            <div class="row g-4 mb-4 text-center">
                                <div class="col-md-3"><div class="glass py-4"><small class="text-secondary">Analiz Sayısı</small><h2 class="m-0 orbitron text-white mt-2">${tToplam}</h2></div></div>
                                <div class="col-md-3"><div class="glass py-4"><small class="text-secondary">Son Net</small><h2 class="m-0 orbitron text-white mt-2">${tSonNet}</h2></div></div>
                                <div class="col-md-3"><div class="glass py-4"><small class="text-secondary">Gelişim İndeksi</small><h2 class="m-0 orbitron mt-2 ${Number(tGelisim) >= 0 ? 'text-success' : 'text-danger'}">${Number(tGelisim) > 0 ? '+'+tGelisim : tGelisim}</h2></div></div>
                                <div class="col-md-3"><div class="glass py-4"><small class="text-secondary">${hedefMetni}</small><h2 class="m-0 orbitron text-warning mt-2">${tKalan}</h2></div></div>
                            </div>
                            <div class="row g-4 mb-4">
                                <div class="col-lg-8"><div class="glass h-100"><h5 class="text-info mb-3 orbitron">${type} Gelişim Grafiği</h5>${chartAreaHTML}</div></div>
                                <div class="col-lg-4"><div class="glass h-100"><h5 class="text-warning mb-3 orbitron">Hedef Durumu</h5><div class="target-bar mb-2"><span style="width:${tTamamlanma}%"></span></div><p class="small text-secondary mb-4">%${tTamamlanma} tamamlandı.</p><h6 class="text-info mt-4 orbitron">Görevler</h6><ul class="text-light small" style="padding-left: 1rem;">${tTasks}</ul></div></div>
                            </div>
                            <div class="glass mb-4"><h5 class="text-info mb-3 orbitron">${type} Sistem Kayıtları</h5><table class="table table-dark table-hover text-center align-middle"><thead><tr><th>Tarih</th><th>Mat</th><th>Türkçe</th><th>Fen</th><th>Sosyal</th><th>Toplam</th><th>İşlem</th></tr></thead><tbody>${tableRows}</tbody></table></div>
                        </div>`;
                    }).join('')}
                </div>`;
            chartScript += '</script>';

            res.send(`
            <!DOCTYPE html>
            <html lang="tr">
            <head>
                <meta charset="UTF-8">
                <title>SmartStudy OS | Panel</title>
                <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Inter:wght@300;500;700&display=swap" rel="stylesheet">
                <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
                <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
                ${cssTheme}
            </head>
            <body class="p-4">
                <main class="container-fluid">
                    <header class="d-flex justify-content-between align-items-center mb-5">
                        <div>
                            <h2 class="text-info mb-1 orbitron fw-bold">SMARTSTUDY OS</h2>
                            <span class="text-secondary">Merhaba, ${escapeHtml(user.ad)}</span>
                        </div>
                        <div class="text-end d-flex align-items-center">
                            <span class="badge ${user.level === 'Premium' ? 'text-bg-warning' : 'text-bg-secondary'} me-3">${escapeHtml(user.level || 'Free')} Üye</span>
                            <a href="/logout" class="btn btn-outline-danger btn-sm orbitron"><i class="fas fa-power-off me-1"></i> Çıkış</a>
                        </div>
                    </header>
                    <div class="row g-4">
                        <aside class="col-md-2">
                            <a href="/dashboard" class="sidebar-link orbitron text-info"><i class="fas fa-columns"></i> Genel Bakış</a>
                            <a href="/plan" class="sidebar-link orbitron"><i class="fas fa-plus-circle"></i> Yeni Analiz</a>
                            <a href="/premium-dersler" class="sidebar-link orbitron text-warning"><i class="fas fa-crown"></i> Premium Modül</a>
                            <a href="/profile" class="sidebar-link orbitron"><i class="fas fa-user-cog"></i> Profil</a>
                        </aside>
                        
                        <section class="col-md-10">
                            <div class="row g-4 mb-4">
                                <div class="col-lg-6"><div class="glass h-100" style="border-color: #ffc107;">${coachHTML}</div></div>
                                <div class="col-lg-6">${premiumLockHTML}</div>
                            </div>
                            ${tabsNavHTML}
                            ${tabsContentHTML}
                        </section>
                    </div>
                </main>
                <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
                ${chartScript}
            </body>
            </html>`);
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

    res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <title>SmartStudy | Profil</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
        <style>
            body{ background:#020617; color:white; font-family:Arial,sans-serif; }
            .panel{ max-width:720px; margin:42px auto; background:rgba(30,41,59,.76); border:1px solid rgba(13,202,240,.25); border-radius:16px; padding:28px; }
            .form-control{ background:#0f172a; border:1px solid #334155; color:white!important; padding:12px; }
            .form-control::placeholder { color: #64748b; }
        </style>
    </head>
    <body>
        <main class="panel">
            <div class="d-flex justify-content-between align-items-center mb-4">
                <div>
                    <h1 class="h3 text-info mb-1">Profil ve Ayarlar</h1>
                    <span class="badge ${user.level === 'Premium' ? 'text-bg-warning' : 'text-bg-secondary'}">${escapeHtml(user.level || 'Free')} Üye</span>
                </div>
                <a href="/dashboard" class="btn btn-outline-info">Panele Dön</a>
            </div>
            <form action="/profile" method="POST" class="row g-3">
                <div class="col-md-6">
                    <label class="form-label">Ad Soyad</label>
                    <input class="form-control" name="ad" value="${escapeHtml(user.ad)}" required>
                </div>
                <div class="col-md-6">
                    <label class="form-label">Email</label>
                    <input class="form-control" name="email" type="email" value="${escapeHtml(user.email)}" required>
                </div>
                <div class="col-md-12">
                    <label class="form-label">Yeni Şifre</label>
                    <input class="form-control" name="newPassword" type="password" placeholder="Değiştirmek istemiyorsan boş bırak">
                </div>
                <div class="col-12 mt-4">
                    <button class="btn btn-info fw-bold w-100 py-2">Değişiklikleri Kaydet</button>
                </div>
            </form>
        </main>
    </body>
    </html>`);
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

app.get('/payment', requireLogin, async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.redirect('/login');

    res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <title>SmartStudy | Güvenli Ödeme Terminali</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Inter:wght@300;500;700&display=swap" rel="stylesheet">
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <style>
            body { background: #020617; color: white; font-family: 'Inter', sans-serif; height: 100vh; display: flex; align-items: center; justify-content: center; }
            .pay-card { background: rgba(30, 41, 59, 0.85); border: 1px solid rgba(255, 193, 7, 0.3); border-radius: 20px; padding: 40px; width: 500px; box-shadow: 0 20px 50px rgba(0,0,0,0.6); }
            .form-control { background: #0f172a; border: 1px solid #334155; color: white !important; padding: 12px; }
        </style>
    </head>
    <body>
        <div class="pay-card">
            <h3 class="text-warning font-monospace mb-2 text-center" style="font-family:'Orbitron', sans-serif;"><i class="fas fa-lock me-2"></i>PREMİUM ÖDEME</h3>
            <p class="text-secondary small text-center mb-4">SmartStudy OS Sonsuz Erişim Paketi - 149.00 TL</p>
            <form action="/payment-success" method="POST">
                <div class="mb-3">
                    <label class="form-label text-info small fw-bold">KART ÜZERİNDEKİ AD SOYAD</label>
                    <input type="text" class="form-control" placeholder="Örn: Mustafa Berke Karakanlı" required>
                </div>
                <div class="mb-3">
                    <label class="form-label text-info small fw-bold">KART NUMARASI</label>
                    <div class="input-group">
                        <span class="input-group-text bg-dark border-secondary text-warning"><i class="fas fa-credit-card"></i></span>
                        <input type="text" class="form-control" placeholder="4532 •••• •••• 8890" maxlength="19" required>
                    </div>
                </div>
                <div class="row mb-4">
                    <div class="col-md-6">
                        <label class="form-label text-info small fw-bold">SON KULLANMA</label>
                        <input type="text" class="form-control" placeholder="AA/YY" maxlength="5" required>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label text-info small fw-bold">CVV GÜVENLİK</label>
                        <input type="password" class="form-control" placeholder="•••" maxlength="4" required>
                    </div>
                </div>
                <button class="btn btn-warning w-100 fw-bold py-3 orbitron text-dark">Ödemeyi Güvenle Tamamla</button>
                <a href="/dashboard" class="d-block text-center text-secondary mt-3 text-decoration-none small">Panele Geri Dön</a>
            </form>
        </div>
    </body>
    </html>`);
});

app.post('/payment-success', requireLogin, async (req, res) => {
    await db.collection('users').doc(req.session.userId).update({ level: 'Premium' });
    req.session.userLevel = 'Premium';
    res.redirect('/dashboard');
});

app.get('/add-video', requireLogin, async (req, res) => {
    const user = await currentUser(req);
    if (!user || user.role !== 'teacher') return res.redirect('/dashboard');

    res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <title>Laboratuvara Video Ekle</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Inter:wght@300;500;700&display=swap" rel="stylesheet">
        <style>
            body { background: #020617; color: white; font-family: 'Inter', sans-serif; padding: 40px; }
            .panel { max-width: 600px; margin: 0 auto; background: rgba(30,41,59,0.8); border: 1px solid rgba(13,202,240,0.3); border-radius: 16px; padding: 30px; }
            .form-control, .form-select { background: #0f172a; border: 1px solid #334155; color: white !important; padding: 12px; }
        </style>
    </head>
    <body>
        <div class="panel">
            <h2 class="text-warning orbitron mb-3">Premium Laboratuvara Video Ekle</h2>
            <form action="/add-video" method="POST">
                <div class="mb-3">
                    <label class="form-label text-info fw-bold">Ders / Branş</label>
                    <select name="ders" class="form-select" required>
                        <option value="matematik">Matematik</option>
                        <option value="turkce">Türkçe / Türk Dili ve Edebiyatı</option>
                        <option value="fizik">Fizik</option>
                        <option value="kimya">Kimya</option>
                        <option value="biyoloji">Biyoloji</option>
                        <option value="cografya">Coğrafya</option>
                        <option value="tarih">Tarih</option>
                        <option value="geometri">Geometri</option>
                    </select>
                </div>
                <div class="mb-3">
                    <label class="form-label text-warning fw-bold">Video Başlığı</label>
                    <input type="text" name="title" class="form-control" placeholder="Örn: TYT Matematik Problem Taktikleri" required>
                </div>
                <div class="mb-3">
                    <label class="form-label text-success fw-bold">Eğitmen / Hoca Adı</label>
                    <input type="text" name="teacher" class="form-control" value="${escapeHtml(user.ad)}" required>
                </div>
                <div class="mb-4">
                    <label class="form-label text-info fw-bold">YouTube Video ID</label>
                    <input type="text" name="videoId" class="form-control" placeholder="Örn: J3pE1TrXhfY" required>
                </div>
                <button class="btn btn-warning w-100 fw-bold py-3 orbitron">Videoyu Sisteme Yükle</button>
                <a href="/dashboard" class="d-block text-center text-secondary mt-3 text-decoration-none">Panele Geri Dön</a>
            </form>
        </div>
    </body>
    </html>`);
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

    const defaultVideos = [
        { id: 'def_1', key: 'matematik', ders: 'Matematik', title: 'TYT Matematik Genel Tekrar', teacher: 'SML Hoca', videoId: 'J3pE1TrXhfY' },
        { id: 'def_2', key: 'turkce', ders: 'Türkçe / Edebiyat', title: 'TYT Türkçe Paragraf Taktikleri', teacher: 'Öznur Saat Yıldırım', videoId: 'CBkWmUCR4K4' },
        { id: 'def_3', key: 'fizik', ders: 'Fizik', title: 'TYT Fizik Genel Tekrar', teacher: 'Fizikfinito', videoId: 'SxwInE8ndkI' },
        { id: 'def_4', key: 'kimya', ders: 'Kimya', title: 'TYT Kimya Genel Tekrar', teacher: 'Meschemy', videoId: '1I-b1UM6ib8' },
        { id: 'def_5', key: 'biyoloji', ders: 'Biyoloji', title: 'TYT Biyoloji Genel Tekrar', teacher: 'Biosem', videoId: 'IOKAsbdHiMc' }
    ];

    const customVidSnap = await db.collection('video_dersler').get();
    const customVideos = customVidSnap.docs.map(d => ({ id: d.id, key: d.data().ders, ...d.data() }));

    const tumVideolar = [...defaultVideos, ...customVideos];

    const videoCards = tumVideolar.map(video => {
        const dersNotlari = notlar.filter(note => note.ders === video.key || note.video_id === video.id);
        const noteRows = dersNotlari.map(note => `
            <div class="card bg-dark border-secondary mb-2 p-2">
                <form action="/update-note" method="POST">
                    <input type="hidden" name="noteId" value="${escapeHtml(note.id)}">
                    <input type="hidden" name="ders" value="${escapeHtml(video.key)}">
                    <input name="notBaslik" value="${escapeHtml(note.not_baslik)}" class="form-control form-control-sm bg-black text-white border-secondary mb-1">
                    <textarea name="notMetni" class="form-control form-control-sm bg-black text-white border-secondary mb-1" rows="2" required>${escapeHtml(note.not_metni)}</textarea>
                    <div class="d-flex justify-content-between align-items-center">
                        <small class="text-muted" style="font-size:0.7rem;">${escapeHtml(new Date(note.tarih).toLocaleDateString('tr-TR'))}</small>
                        <button class="btn btn-sm btn-info py-0 px-2" style="font-size:0.75rem;">Güncelle</button>
                    </div>
                </form>
                <form action="/delete-note" method="POST" class="mt-1">
                    <input type="hidden" name="noteId" value="${escapeHtml(note.id)}">
                    <input type="hidden" name="ders" value="${escapeHtml(video.key)}">
                    <button class="btn btn-sm btn-outline-danger py-0 px-2 w-100" style="font-size:0.7rem;">Notu Sil</button>
                </form>
            </div>
        `).join('') || '<p class="text-muted small">Bu video için henüz not alınmamış.</p>';

        return `
            <div class="card bg-secondary bg-opacity-10 border border-info border-opacity-25 rounded-4 p-4 mb-4">
                <span class="badge bg-warning text-dark mb-2 align-self-start">${escapeHtml(video.ders || 'Genel')} (${escapeHtml(video.teacher || 'Eğitmen')})</span>
                <h4 class="text-info mb-3">${escapeHtml(video.title)}</h4>
                <div class="ratio ratio-16x9 mb-3 rounded overflow-hidden border border-secondary">
                    <iframe src="https://www.youtube.com/embed/${escapeHtml(video.videoId)}" title="${escapeHtml(video.title)}" allowfullscreen></iframe>
                </div>
                <div class="mt-3">
                    <h6 class="text-warning mb-2"><i class="fas fa-edit me-1"></i> Kişisel Not Al</h6>
                    <form action="/save-note" method="POST">
                        <input type="hidden" name="ders" value="${escapeHtml(video.key)}">
                        <input type="hidden" name="videoId" value="${escapeHtml(video.id)}">
                        <input type="hidden" name="videoTitle" value="${escapeHtml(video.title)}">
                        <input name="notBaslik" placeholder="Not Başlığı" class="form-control form-control-sm bg-dark text-white border-secondary mb-2" required>
                        <textarea name="notMetni" placeholder="Ders notunu buraya yaz..." class="form-control form-control-sm bg-dark text-white border-secondary mb-2" rows="3" required></textarea>
                        <button class="btn btn-warning btn-sm w-100 fw-bold">Notu Kaydet</button>
                    </form>
                </div>
                <div class="mt-4 pt-3 border-top border-secondary">
                    <h6 class="text-light mb-2 small fw-bold">Kayıtlı Notlarım</h6>
                    <div style="max-height: 220px; overflow-y: auto;">
                        ${noteRows}
                    </div>
                </div>
            </div>`;
    }).join('');

    res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <title>Premium Video Laboratuvarı</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-dark text-white p-4">
        <main class="container py-4">
            <header class="d-flex justify-content-between align-items-center mb-5 pb-3 border-bottom border-secondary">
                <div>
                    <h1 class="text-warning fw-bold"><i class="fas fa-crown me-2"></i> Premium Video Laboratuvarı</h1>
                </div>
                <a href="/dashboard" class="btn btn-outline-info">Panele Dön</a>
            </header>
            <div class="row">
                <div class="col-lg-10 mx-auto">
                    ${videoCards}
                </div>
            </div>
        </main>
    </body>
    </html>`);
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

app.post('/delete-analysis', requireLogin, async (req, res) => {
    try { 
        await db.collection('analizler').doc(req.body.analizId).delete(); 
        res.redirect('/dashboard'); 
    } catch (error) { 
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Analiz silinemedi.', '/dashboard')); 
    }
});

app.post('/generate-plan', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        let toplamNet = 0; 
        const detaylar = {};
        const sinav_turu = req.body.sinav_turu || 'TYT';
        const hedef_net = req.body.hedef ? Number(req.body.hedef) : null;
        
        for (const [key, value] of Object.entries(req.body)) {
            if (!['sinav_turu', 'role', 'hedef'].includes(key)) { 
                detaylar[key] = Number(value) || 0; 
                toplamNet += detaylar[key]; 
            }
        }
        
        await db.collection('analizler').add({ 
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
        
        res.redirect('/dashboard');
    } catch (error) { 
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Analiz kaydedilemedi.', '/plan')); 
    }
});

app.post('/assign-homework', requireLogin, async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user || user.role !== 'teacher') {
            return res.status(403).send(errorPage('Yetki Hatası', 'Sadece öğretmenler ödev verebilir.', '/dashboard'));
        }
        
        let subject = req.body.subject;
        if (user.teacher_type === 'brans') {
            subject = user.branch;
        }

        const { student_id, exam_type } = req.body;
        let assigned_topics = req.body.assigned_topics;
        
        if (!assigned_topics) return res.status(400).send(errorPage('Eksik Veri', 'Lütfen en az bir konu seçimi yapın.', '/plan'));
        if (!Array.isArray(assigned_topics)) assigned_topics = [assigned_topics];

        await db.collection('homeworks').add({ 
            teacher_id: user.id, 
            student_id: student_id, 
            exam_type, 
            subject: subject || 'Genel', 
            topics: assigned_topics, 
            date_assigned: new Date().toISOString(), 
            status: 'pending' 
        });
        
        res.redirect('/dashboard');
    } catch (error) { 
        console.error(error);
        res.status(500).send(errorPage('Hata', 'Ödev atanamadı.', '/plan')); 
    }
});

app.use((req, res) => { 
    res.status(404).send(errorPage('Sayfa Bulunamadı', 'Aradığınız rota mevcut değil.', '/dashboard')); 
});

app.listen(PORT, () => { 
    console.log(`SmartStudy OS Firebase bağlantısı ile http://localhost:${PORT} adresinde çalışıyor!`); 
});
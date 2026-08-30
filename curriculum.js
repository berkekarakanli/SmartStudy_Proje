// Sınav müfredatı + sınav tarihleri - AI Koç'un (Faz 2/3) sınıfa uygun
// konu önermesi ve zaman planlaması yapabilmesi için.
//
// NOT: Buradaki ders/konu listesi, backend/public/analysis.html içindeki
// öğretmen ödev atama ekranında kullanılan `teacherSyllabus` verisiyle
// AYNI İÇERİKTEDİR - bilinçli olarak burada bir kopyası tutuluyor, çünkü
// analysis.html tamamen istemci tarafında (tarayıcıda) çalışıyor ve o
// çalışan özelliğe dokunmadan sunucu tarafında da aynı veriye ihtiyaç
// duyuyoruz. İleride tek bir kaynağa indirgenebilir (örn. server'dan
// /api/curriculum ile servis edilip analysis.html oradan çekebilir).

// ÖSYM/MEB tarafından ilan edilen (ya da henüz ilan edilmediyse geçmiş
// yıllara göre TAHMİNİ) sınav tarihleri. Bunlar HER YIL güncellenmeli -
// Berke'den güncel tarih geldiğinde burası değiştirilecek.
const EXAM_DATES = {
    // TODO: ÖSYM ilan edince gerçek tarihle güncelle.
    TYT: '2027-06-19',
    AYT: '2027-06-20',
    LGS: '2027-06-07',
    KPSS: '2027-07-11'
};

const SYLLABUS = {
    TYT: {
        'Türkçe / Türk Dili ve Edebiyatı': [
            'Sözcükte Anlam', 'Söz Yorumu', 'Deyim ve Atasözleri', 'Cümlede Anlam', 'Paragrafta Anlam',
            'Paragrafta Yapı', 'Paragrafta Düşünceyi Geliştirme Yolları', 'Paragrafta Anlatım Teknikleri',
            'Ses Bilgisi', 'Yazım Kuralları', 'Noktalama İşaretleri', 'Sözcükte Yapı / Ekler',
            'Sözcük Türleri: İsimler', 'Sözcük Türleri: Zamirler', 'Sözcük Türleri: Sıfatlar',
            'Sözcük Türleri: Zarflar', 'Sözcük Türleri: Edat-Bağlaç-Ünlem', 'Fiiller', 'Ek Fiil',
            'Fiilimsiler', 'Fiilde Çatı', 'Cümlenin Öğeleri', 'Cümle Türleri', 'Anlatım Bozuklukları'
        ],
        'Matematik': [
            'Temel Kavramlar', 'Sayı Basamakları', 'Bölme ve Bölünebilme', 'EBOB-EKOK',
            'Rasyonel Sayılar', 'Basit Eşitsizlikler', 'Mutlak Değer', 'Üslü Sayılar', 'Köklü Sayılar',
            'Çarpanlara Ayırma', 'Oran-Orantı', 'Denklem Çözme', 'Sayı Problemleri', 'Kesir Problemleri',
            'Yaş Problemleri', 'İşçi-Havuz Problemleri', 'Hareket Problemleri', 'Yüzde-Kâr-Zarar Problemleri',
            'Karışım Problemleri', 'Kümeler', 'Mantık', 'Fonksiyonlar', 'Polinomlar',
            'Permütasyon', 'Kombinasyon', 'Binom', 'Olasılık', 'Veri-İstatistik'
        ],
        'Geometri': [
            'Doğruda ve Üçgende Açılar', 'Özel Üçgenler', 'Üçgende Açı-Kenar Bağıntıları',
            'Üçgende Yardımcı Elemanlar', 'Üçgende Benzerlik', 'Üçgende Alan', 'Çokgenler',
            'Dörtgenler', 'Yamuk', 'Paralelkenar', 'Eşkenar Dörtgen ve Deltoit', 'Çember ve Daire',
            'Analitik Geometri: Nokta ve Doğru', 'Katı Cisimler (Prizma, Silindir)', 'Katı Cisimler (Piramit, Koni, Küre)'
        ],
        'Tarih': [
            'Tarih ve Zaman', 'Tarih Yazıcılığı', 'İnsanlığın İlk Dönemleri', 'İlk Çağ Uygarlıkları',
            'Orta Çağ\'da Dünya', 'İlk ve Orta Çağlarda Türk Dünyası', 'İslam Medeniyetinin Doğuşu',
            'Türklerin İslamiyeti Kabulü', 'İlk Türk İslam Devletleri', 'Türkiye Selçuklu Devleti',
            'Beylikten Devlete Osmanlı Siyaseti', 'Devletleşme Sürecinde Savaşçılar ve Askerler',
            'Beylikten Devlete Osmanlı Medeniyeti', 'Dünya Gücü Osmanlı', 'Sultan ve Osmanlı Merkez-Taşra Teşkilatı',
            'Klasik Çağda Osmanlı Toplum Düzeni'
        ],
        'Coğrafya': [
            'Doğa ve İnsan', 'Dünya\'nın Şekli ve Hareketleri', 'Coğrafi Konum', 'Harita Bilgisi',
            'Atmosfer ve İklim', 'Sıcaklık', 'Basınç ve Rüzgarlar', 'Nem-Yağış ve İklim Tipleri',
            'Türkiye\'nin İklimi', 'İç Kuvvetler (Volkanizma-Depremler)', 'Dış Kuvvetler (Akarsu-Rüzgar-Buzul)',
            'Su Kaynakları', 'Toprak Tipleri ve Bitki Örtüsü', 'Nüfus Politikaları', 'Göç ve Yerleşme',
            'Ekonomik Faaliyetler ve Bölgeler', 'Doğal Afetler ve Çevre'
        ],
        'Fizik': [
            'Fizik Bilimine Giriş', 'Madde ve Özellikleri', 'Sıvıların Kaldırma Kuvveti', 'Basınç',
            'Isı, Sıcaklık ve Genleşme', 'Hareket ve Kuvvet', 'Dinamik (Newton Yasaları)', 'İş, Güç ve Enerji',
            'Elektrostatik', 'Elektrik Akımı ve Devreler', 'Manyetizma', 'Dalgalar (Yay-Su-Ses)',
            'Optik: Aydınlanma ve Gölge', 'Optik: Yansıma ve Aynalar', 'Optik: Kırılma ve Mercekler'
        ],
        'Kimya': [
            'Kimya Bilimi', 'Kimyasal Türler Arası Etkileşimler', 'Güçlü ve Zayıf Etkileşimler',
            'Maddenin Halleri: Katı', 'Maddenin Halleri: Sıvı ve Gaz', 'Doğa ve Kimya',
            'Atom ve Periyodik Sistem', 'Kimyasal Hesaplamalar (Mol Kavramı)', 'Karışımlar',
            'Asitler, Bazlar ve Tuzlar', 'Kimya Her Yerde (Endüstri ve Çevre)'
        ],
        'Biyoloji': [
            'Canlıların Ortak Özellikleri', 'Canlıların Temel Bileşenleri', 'Hücre Zarından Madde Geçişi',
            'Hücre Yapısı ve Organeller', 'Canlılar Dünyası: Sınıflandırma', 'Canlılar Alemleri',
            'Hücre Bölünmeleri: Mitoz', 'Hücre Bölünmeleri: Mayoz', 'Üreme Çeşitleri',
            'Kalıtımın Genel İlkeleri', 'Soyağacı ve Akraba Evliliği', 'Ekosistem Ekolojisi',
            'Güncel Çevre Sorunları'
        ]
    },
    AYT: {
        'Türkçe / Türk Dili ve Edebiyatı': [
            'Anlam Bilgisi ve Paragraf', 'Cümle ve Metin Türleri', 'Şiir Bilgisi: Ölçü ve Uyak',
            'Söz Sanatları', 'İslamiyet Öncesi Türk Edebiyatı', 'Geçiş Dönemi Eserleri',
            'Halk Edebiyatı: Aşık Tarzı', 'Halk Edebiyatı: Anonim ve Tasavvuf', 'Divan Edebiyatı: Nazım Şekilleri',
            'Divan Edebiyatı: Şairler ve Eserler', 'Tanzimat Edebiyatı I. Dönem', 'Tanzimat Edebiyatı II. Dönem',
            'Servet-i Fünun Edebiyatı', 'Fecr-i Ati Edebiyatı', 'Milli Edebiyat Dönemi',
            'Cumhuriyet Dönemi Şiiri (Öz Şiir/Toplumcu)', 'Cumhuriyet Dönemi Şiiri (Garip/İkinci Yeni)',
            'Cumhuriyet Dönemi Roman ve Öykü', 'Cumhuriyet Dönemi Tiyatro ve Deneme', 'Dünya Edebiyatından Akımlar'
        ],
        'Matematik': [
            'Temel Kavramlar ve Sayılar', 'Polinomlar', 'İkinci Dereceden Denklemler', 'Karmaşık Sayılar',
            'Parabol', 'Eşitsizlikler', 'Trigonometri: Temel Kavramlar', 'Trigonometri: Formüller',
            'Logaritma', 'Diziler', 'Limit ve Süreklilik', 'Türev: Temel Kurallar',
            'Türev: Uygulamaları (Grafik Çizimi)', 'İntegral: Belirsiz İntegral', 'İntegral: Belirli İntegral ve Alan'
        ],
        'Geometri': [
            'Üçgenler', 'Çokgenler ve Dörtgenler', 'Çember ve Daire', 'Trigonometri Geometrisi',
            'Analitik Geometri: Doğru', 'Analitik Geometri: Çember', 'Katı Cisimler', 'Vektörler', 'Dönüşüm Geometrisi'
        ],
        'Fizik': [
            'Vektörler ve Bağıl Hareket', 'Newton\'un Hareket Yasaları', 'Atışlar (Yatay/Eğik)',
            'İş, Güç ve Enerji II', 'Momentum ve Çarpışmalar', 'Tork, Denge ve Ağırlık Merkezi',
            'Basit Makineler', 'Elektrik Alan ve Potansiyel', 'Sığaçlar (Kondansatörler)',
            'Elektrik Akımı, Direnç ve Devreler', 'Manyetik Alan ve Manyetik Kuvvet', 'Elektromanyetik İndüksiyon',
            'Çembersel Hareket', 'Basit Harmonik Hareket', 'Dalga Mekaniği: Girişim ve Kırınım',
            'Dalga Mekaniği: Doppler Olayı', 'Modern Fizik: Kuantum', 'Modern Fizik: Radyoaktivite ve Özel Görelilik'
        ],
        'Kimya': [
            'Kimyasal Hesaplamalar', 'Modern Atom Teorisi', 'Gazlar: Basınç ve Kanunlar',
            'Gazlar: Karışımlar', 'Sıvı Çözeltiler', 'Koligatif Özellikler', 'Kimyasal Tepkimelerde Enerji (Entalpi)',
            'Tepkimelerde Hız', 'Kimyasal Denge', 'Asit-Baz Dengesi', 'Çözünürlük Dengesi (KÇÇ)',
            'Elektrokimya: Pil', 'Elektrokimya: Elektroliz', 'Organik Kimyaya Giriş',
            'Hidrokarbonlar', 'Organik Bileşikler ve Fonksiyonel Gruplar'
        ],
        'Biyoloji': [
            'Sinir Sistemi', 'Endokrin Sistem ve Hormonlar', 'Duyu Organları', 'Destek ve Hareket Sistemi',
            'Sindirim Sistemi', 'Dolaşım ve Bağışıklık Sistemi', 'Solunum Sistemi', 'Boşaltım Sistemi',
            'Üreme Sistemi ve Embriyonik Gelişim', 'Komünite ve Popülasyon Ekolojisi',
            'Nükleik Asitler (DNA/RNA)', 'Protein Sentezi', 'Fotosentez', 'Kemosentez ve Hücresel Solunum',
            'Bitkilerde Taşınma', 'Bitkisel Dokular ve Üreme', 'Canlılarda Evrim', 'Biyoteknoloji ve Gen Mühendisliği'
        ],
        'Tarih': [
            'Tarih Bilimi ve Tarih Yazıcılığı', 'Dünya Tarihi: İlk Çağ\'dan Orta Çağ\'a',
            'Türkistan ve İlk Türk Devletleri', 'İslamiyetin Doğuşu ve İlk Türk-İslam Devletleri',
            'Orta Çağ ve Yeni Çağ\'da Avrupa', 'Osmanlı Siyasi Gelişmeleri (Kuruluş-Yükselme)',
            'Osmanlı Kültür ve Medeniyeti', 'XIX. Yüzyılda Osmanlı', 'XX. Yüzyıl Başlarında Osmanlı',
            'I. Dünya Savaşı ve Sonrası', 'Milli Mücadele Hazırlık Dönemi', 'Kurtuluş Savaşı ve Cepheler',
            'Atatürkçülük ve Türk İnkılabı', 'İki Savaş Arası Dönem (1920-1939)',
            'II. Dünya Savaşı ve Soğuk Savaş Dönemi', 'Küreselleşen Dünya ve 21. Yüzyıl'
        ],
        'Coğrafya': [
            'Ekosistemlerin Özellikleri ve İşleyişi', 'Biyoçeşitlilik ve Madde Döngüleri',
            'Ekstrem Doğa Olayları', 'Küresel İklim Değişikliği', 'Nüfus Politikaları ve Projeksiyonları',
            'Şehirler ve Kırsal Yerleşmeler', 'Dünyada Doğal Kaynak ve Ekonomi',
            'Türkiye\'de Tarım ve Hayvancılık', 'Türkiye\'de Sanayi', 'Türkiye\'de Maden ve Enerji Kaynakları',
            'Türkiye\'de Ekonomi, Şehirleşme ve Göç', 'İşlevsel Bölge ve Kalkınma Projeleri',
            'Hizmet Sektörü ve Ulaşım', 'Türkiye\'de ve Dünyada Ticaret', 'Türkiye\'de Turizm',
            'Küresel Ortam: Bölgeler ve Ülkeler', 'Çevre ve Toplum'
        ],
        'Felsefe Grubu': [
            'Felsefenin Konusu', 'Bilgi Felsefesi', 'Varlık Felsefesi', 'Ahlak Felsefesi', 'Din Felsefesi',
            'Siyaset Felsefesi', 'Sanat Felsefesi', 'Bilim Felsefesi', 'MÖ 6.-MS 2. Yüzyıl Felsefesi',
            'MS 2.-MS 15. Yüzyıl Felsefesi', '15.-17. Yüzyıl Felsefesi', '18.-19. Yüzyıl Felsefesi',
            '20. Yüzyıl Felsefesi', 'Psikoloji Bilimini Tanıyalım', 'Psikolojinin Temel Süreçleri',
            'Öğrenme, Bellek ve Düşünme', 'Ruh Sağlığının Temelleri', 'Sosyolojiye Giriş',
            'Birey ve Toplum', 'Toplumsal Yapı', 'Toplumsal Değişme ve Gelişme', 'Toplum ve Kültür',
            'Toplumsal Kurumlar', 'Klasik Mantık', 'Mantık ve Dil', 'Sembolik Mantık'
        ]
    },
    KPSS: {
        'Türkçe': [
            'Sözcükte Anlam', 'Cümlede Anlam', 'Paragrafta Anlam ve Anlatım Teknikleri', 'Ses Bilgisi',
            'Yazım Kuralları', 'Noktalama İşaretleri', 'Sözcükte Yapı', 'Sözcük Türleri', 'Fiiller ve Fiilimsiler',
            'Cümlenin Öğeleri', 'Cümle Türleri', 'Anlatım Bozuklukları', 'Sözel Mantık ve Muhakeme'
        ],
        'Matematik': [
            'Temel Kavramlar', 'Sayı Basamakları', 'Bölme-Bölünebilme', 'EBOB-EKOK', 'Rasyonel Sayılar',
            'Basit Eşitsizlikler ve Mutlak Değer', 'Üslü ve Köklü Sayılar', 'Çarpanlara Ayırma', 'Oran-Orantı',
            'Sayı ve Kesir Problemleri', 'Yaş-İşçi-Hareket Problemleri', 'Yüzde-Kâr/Zarar-Karışım Problemleri',
            'Kümeler', 'Fonksiyonlar', 'Permütasyon-Kombinasyon-Olasılık', 'Tablo ve Grafik Yorumlama',
            'Sayısal Mantık', 'Temel Geometri Kavramları'
        ],
        'Tarih': [
            'İslamiyet Öncesi Türk Tarihi', 'İlk Türk-İslam Devletleri', 'Türkiye Selçuklu Devleti',
            'Osmanlı Kuruluş Dönemi', 'Osmanlı Yükselme Dönemi', 'Osmanlı Duraklama Dönemi',
            'Osmanlı Gerileme ve Dağılma Dönemi', 'Osmanlı Kültür ve Medeniyeti', '19. Yüzyıl Islahatları',
            'XX. Yüzyılda Osmanlı Devleti', 'Milli Mücadele Hazırlık Dönemi (Kongreler)',
            'Kurtuluş Savaşı Cepheleri', 'Türk İnkılabı', 'Atatürk İlkeleri', 'Atatürk Dönemi İç ve Dış Politika',
            'Çağdaş Türk ve Dünya Tarihi'
        ],
        'Coğrafya': [
            'Türkiye\'nin Coğrafi Konumu', 'Türkiye\'nin Yer Şekilleri ve Dağları', 'Türkiye\'nin Akarsu ve Gölleri',
            'Türkiye\'nin İklimi ve Bitki Örtüsü', 'Türkiye\'de Toprak Tipleri ve Doğal Afetler',
            'Türkiye\'nin Nüfusu ve Yerleşme Özellikleri', 'Türkiye\'de Tarım ve Hayvancılık',
            'Türkiye\'de Madenler ve Enerji Kaynakları', 'Türkiye\'de Sanayi ve Ticaret',
            'Türkiye\'de Ulaşım', 'Türkiye\'nin Turizmi', 'Bölgeler Coğrafyası'
        ],
        'Vatandaşlık': [
            'Hukukun Temel Kavramları', 'Hukukun Kaynakları', 'Devlet Teşkilatı ve Hükûmet Sistemleri',
            'Anayasa Hukukuna Giriş', '1982 Anayasası\'nın Genel Esasları', 'Temel Hak ve Hürriyetler',
            'Yasama Organı (TBMM)', 'Yürütme Organı (Cumhurbaşkanlığı)', 'Yargı Organı ve Yüksek Mahkemeler',
            'İdare Hukuku ve İdari Teşkilat', 'Uluslararası Kuruluşlar'
        ],
        'Güncel Olaylar': [
            'Ulusal Güncel Gelişmeler', 'Uluslararası Güncel Gelişmeler',
            'Türkiye\'nin Üye Olduğu Uluslararası Kuruluşlar', 'Bilim ve Teknolojideki Gelişmeler',
            'Sanat, Kültür ve Spordaki Gelişmeler'
        ]
    },
    LGS: {
        'Türkçe / Türk Dili ve Edebiyatı': [
            'Fiilimsiler', 'Cümlenin Öğeleri', 'Fiilde Çatı', 'Sözcükte Anlam', 'Cümlede Anlam',
            'Cümle Çeşitleri', 'Yazım Kuralları', 'Paragrafta Anlam ve Yapı', 'Noktalama İşaretleri',
            'Anlatım Bozuklukları', 'Söz Sanatları', 'Metin Türleri'
        ],
        'Matematik': [
            'Çarpanlar ve Katlar', 'Üslü İfadeler', 'Kareköklü İfadeler', 'Veri Analizi',
            'Basit Olayların Olma Olasılığı', 'Cebirsel İfadeler ve Özdeşlikler',
            'Doğrusal Denklemler', 'Eşitsizlikler', 'Üçgenler', 'Eşlik ve Benzerlik',
            'Dönüşüm Geometrisi', 'Geometrik Cisimler (Silindir-Koni-Küre)'
        ],
        'Fen Bilimleri': [
            'Mevsimler ve İklim', 'DNA ve Genetik Kod', 'Basınç', 'Madde ve Endüstri',
            'Basit Makineler', 'Enerji Dönüşümleri ve Çevre Bilimi', 'Elektrik Yükleri ve Elektrik Enerjisi'
        ],
        'T.C. İnkılap Tarihi ve Atatürkçülük': [
            'Bir Kahraman Doğuyor', 'Millî Uyanış: Bağımsızlık Yolunda Atılan Adımlar',
            'Millî Bir Destan: Ya İstiklal Ya Ölüm', 'Atatürkçülük ve Çağdaşlaşan Türkiye',
            'Demokratikleşme Çabaları', 'Atatürk Dönemi Türk Dış Politikası',
            'Atatürk\'ün Ölümü ve Sonrası', 'Atatürk İlkeleri (Bütünleyici/Cumhuriyetçilik/Milliyetçilik vb.)'
        ],
        'Din Kültürü ve Ahlak Bilgisi': [
            'Kader İnancı (Kaza ve Kader)', 'Zekât, Sadaka ve Hac', 'Din ve Hayat',
            'Hz. Muhammed\'in (s.a.v.) Örnekliği', 'Kur\'an-ı Kerim ve Özellikleri'
        ],
        'İngilizce': [
            'Friendship', 'Teen Life', 'In The Kitchen', 'On The Phone',
            'Adventures', 'Tourism', 'Chores', 'Science'
        ]
    }
};

const GECERLI_SINIFLAR = ['8', '9', '10', '11', '12', 'Mezun', 'KPSS Adayı'];
const GECERLI_AYT_ALANLARI = ['SAY', 'EA', 'SOZ'];

/**
 * Öğrencinin sınıfına (ve varsa AYT alanına) göre HANGİ sınavın müfredatına
 * tabi olduğunu ve o müfredattaki ders/konu listesini döndürür.
 * @param {string} sinif
 * @param {string} [aytAlani] - 'SAY' | 'EA' | 'SOZ'
 * @returns {{ sinavTuru: string, dersler: Record<string, string[]> }}
 */
function getMufredat(sinif, aytAlani) {
    if (sinif === '8') {
        return { sinavTuru: 'LGS', dersler: SYLLABUS.LGS };
    }
    if (sinif === 'KPSS Adayı') {
        return { sinavTuru: 'KPSS', dersler: SYLLABUS.KPSS };
    }
    if (sinif === '9' || sinif === '10') {
        return { sinavTuru: 'TYT', dersler: SYLLABUS.TYT };
    }
    if (sinif === '11' || sinif === '12' || sinif === 'Mezun') {
        const aytDersler = { ...SYLLABUS.TYT };
        if (aytAlani === 'SAY') {
            Object.assign(aytDersler, {
                Matematik: [...SYLLABUS.TYT.Matematik, ...SYLLABUS.AYT.Matematik],
                Geometri: [...SYLLABUS.TYT.Geometri, ...SYLLABUS.AYT.Geometri],
                Fizik: SYLLABUS.AYT.Fizik, Kimya: SYLLABUS.AYT.Kimya, Biyoloji: SYLLABUS.AYT.Biyoloji
            });
        } else if (aytAlani === 'EA') {
            Object.assign(aytDersler, {
                Matematik: [...SYLLABUS.TYT.Matematik, ...SYLLABUS.AYT.Matematik],
                'Türkçe / Türk Dili ve Edebiyatı': [...SYLLABUS.TYT['Türkçe / Türk Dili ve Edebiyatı'], ...SYLLABUS.AYT['Türkçe / Türk Dili ve Edebiyatı']],
                Tarih: SYLLABUS.AYT.Tarih, Coğrafya: SYLLABUS.AYT.Coğrafya
            });
        } else if (aytAlani === 'SOZ') {
            Object.assign(aytDersler, {
                'Türkçe / Türk Dili ve Edebiyatı': [...SYLLABUS.TYT['Türkçe / Türk Dili ve Edebiyatı'], ...SYLLABUS.AYT['Türkçe / Türk Dili ve Edebiyatı']],
                Tarih: SYLLABUS.AYT.Tarih, Coğrafya: SYLLABUS.AYT.Coğrafya,
                'Felsefe Grubu': SYLLABUS.AYT['Felsefe Grubu']
            });
        }
        return { sinavTuru: 'TYT+AYT', dersler: aytDersler };
    }
    // Bilinmeyen/boş sınıf: güvenli varsayılan TYT.
    return { sinavTuru: 'TYT', dersler: SYLLABUS.TYT };
}

/**
 * Onboarding formunda "kaç kaynağın var" diye sorulacak ders adları listesi
 * (getMufredat'ın döndürdüğü derslerin isimleri).
 */
function getKaynakDersleri(sinif, aytAlani) {
    return Object.keys(getMufredat(sinif, aytAlani).dersler);
}

module.exports = { EXAM_DATES, SYLLABUS, GECERLI_SINIFLAR, GECERLI_AYT_ALANLARI, getMufredat, getKaynakDersleri };

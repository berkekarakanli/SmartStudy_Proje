-- SmartStudy - Supabase Postgres şeması
-- Firestore'daki 7 koleksiyonun (users, analizler, wrong_questions,
-- homeworks, video_dersler, video_notlari, destek_talepleri) karşılığı.
-- "sessions" koleksiyonu (özel Firestore oturum deposu) burada YOK -
-- Supabase Auth kendi JWT tabanlı oturum yönetimini kullanıyor.
--
-- Kimlik doğrulama Supabase Auth'a taşındığı için "users" tablosu artık
-- şifre TUTMUYOR; auth.users (Supabase'in kendi dahili tablosu) şifreyi
-- yönetiyor, burada sadece profil/uygulama verisi var - bu yüzden tablo
-- adı "profiles" (Supabase'in kendi dokümantasyonundaki standart adlandırma).
--
-- Bu dosyayı Supabase Dashboard > SQL Editor'e yapıştırıp çalıştırman
-- yeterli - tüm tabloları, indeksleri ve RLS politikalarını kurar.

-- ==========================================
-- 1. PROFILES (eski "users" koleksiyonu)
-- ==========================================
create table public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    role text not null default 'student' check (role in ('student', 'teacher')),
    ad text not null,
    email text not null unique,
    level text not null default 'Free' check (level in ('Free', 'Premium')),

    -- Öğretmen alanları
    koc_kodu text unique,
    teacher_type text check (teacher_type in ('koc', 'brans')),
    branch text,

    -- Öğrenci -> koç eşleştirme
    bagli_koc_kodlari text[] default '{}',
    bagli_koc_listesi jsonb default '[]'::jsonb,
    bagli_koc_kodu text,
    bagli_koc_ad text,

    -- Yasal onaylar
    kvkk_onay boolean default false,
    sozlesme_onay boolean default false,
    onay_tarihi timestamptz,

    -- Davet sistemi
    referral_code text unique,
    referral_count integer not null default 0,
    referred_by uuid references public.profiles(id),

    -- Tercihler
    email_notifications boolean not null default true,
    study_reminders boolean not null default true,

    -- İstatistikler
    pomodoro_dakika integer not null default 0,
    en_yuksek_net numeric,
    en_yuksek_net_tarih timestamptz,

    kayit_tarihi timestamptz not null default now(),

    -- AI Koç onboarding (Faz 2/3) - sınıfına/hedefine göre kişiselleştirilmiş
    -- çalışma programı üretebilmek için bir kere sorulur. (kaynak_sayilari
    -- bilinçli olarak KALDIRILDI - ödevlendirme artık herkese eşit hacimde,
    -- kaynağı az olan öğrenciye daha az soru verilmesi adaletsiz bulundu.)
    sinif text,
    ayt_alani text check (ayt_alani in ('SAY', 'EA', 'SOZ')),
    hedef text,
    -- { dersAdi: [konu, konu, ...] } - sohbet sırasında öğrencinin "bunu
    -- zaten bitirdim" dediği konular; ödev planı bunları tekrar "öğren" diye
    -- vermez, sadece hata varsa pekiştirme olarak önerir.
    tamamlanan_konular jsonb default '{}'::jsonb,
    -- { dersAdi: [konu, konu, ...] } - öğrencinin sohbette AÇIKÇA "bu konuda
    -- yanlış yapıyorum/zorlanıyorum" dediği konular. Bir ders için net yüzdesi
    -- çok yüksek olsa bile (örn. 120 üzerinden 119), AI Koç bunu "her şey
    -- mükemmel" diye kabul etmeyip mutlaka spesifik konuyu sormalı - o cevap
    -- burada tutulur ve ödev planında EN YÜKSEK öncelik burası olur.
    zayif_konular jsonb default '{}'::jsonb,
    -- "Hangi konuları bitirdin" sorusu artık sohbetle değil, sınıfı
    -- belirlenince bir kerelik tik listesiyle soruluyor (serbest metinden
    -- konu çıkarmak güvenilmez çıktı) - bu liste bir kez cevaplanınca true olur.
    konu_durumu_soruldu boolean not null default false,
    ai_onboarding_tamamlandi boolean not null default false,
    -- Haftalık program döngüsü: hangi hafta numarasındayız ve en son ne zaman
    -- yeni bir program üretildi - 7 günden fazla geçtiyse sohbette otomatik
    -- olarak yeni bir haftalık program duyurulur.
    hafta_no integer not null default 0,
    haftalik_program_tarihi timestamptz
);

create index idx_profiles_referral_code on public.profiles(referral_code);
create index idx_profiles_koc_kodu on public.profiles(koc_kodu);
create index idx_profiles_bagli_koc_kodu on public.profiles(bagli_koc_kodu);

-- ==========================================
-- 2. ANALIZLER
-- ==========================================
create table public.analizler (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    sinav_turu text not null default 'TYT',
    hedef_net numeric,
    toplam_net numeric not null default 0,
    detaylar jsonb not null default '{}'::jsonb,
    -- Eski (detaylar alanından önceki) TYT kayıtları için geriye dönük uyumluluk
    matematik numeric default 0,
    turkce numeric default 0,
    fen numeric default 0,
    sosyal numeric default 0,
    tarih timestamptz not null default now()
);

create index idx_analizler_user_id on public.analizler(user_id);
create index idx_analizler_user_tarih on public.analizler(user_id, tarih);

-- ==========================================
-- 3. WRONG_QUESTIONS (Dijital Hata Defteri)
-- ==========================================
-- NOT: image_base64 (Firestore'dakiyle aynı isim/yaklaşım) korunuyor -
-- istemci zaten fotoğrafı bir canvas ile küçültüp JPEG olarak yeniden
-- sıkıştırıyor, Postgres'in "text" alanı için pratik bir boyut sınırı yok
-- (Firestore'daki 1 MiB doküman limiti gibi bir kısıtlama burada söz
-- konusu değil), bu yüzden Storage'a taşımaya gerek kalmadı.
create table public.wrong_questions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    question_text text default 'Hatalı Soru Kaydı',
    -- Hangi derse ait olduğu (AI Koç'un "normalde güçlü olduğun derste hata
    -- yaptın" gibi tepkisel farkındalık göstermesi için gerekli - eskiden
    -- tutulmuyordu).
    subject text,
    ai_solution text default '',
    image_base64 text,
    tarih timestamptz not null default now()
);

create index idx_wrong_questions_user_id on public.wrong_questions(user_id);

-- ==========================================
-- 4. HOMEWORKS (Ödevler)
-- ==========================================
create table public.homeworks (
    id uuid primary key default gen_random_uuid(),
    -- AI Koç'un ürettiği ödevlerde öğretmen olmadığı için nullable -
    -- kaynağı (kim verdi) ayrıca "source" sütununda tutuluyor.
    teacher_id uuid references public.profiles(id) on delete cascade,
    student_id uuid not null references public.profiles(id) on delete cascade,
    exam_type text not null,
    subject text not null default 'Genel',
    topics text[] not null default '{}',
    question_count integer,
    date_assigned timestamptz not null default now(),
    status text not null default 'pending',
    completed boolean not null default false,
    source text not null default 'teacher' check (source in ('teacher', 'ai')),
    -- AI Koç'un haftalık program üretebilmesi için - "Pazartesi bu, Salı şu"
    -- şeklinde günlere dağıtılmış görevler. Öğretmen ödevlerinde (source
    -- ='teacher') kullanılmıyor, null kalıyor.
    gun text check (gun in ('Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar')),
    -- Hangi haftalık programa ait olduğu - AI Koç her hafta yeni bir program
    -- üretince artıyor. Sadece son 2 haftanın AI ödevleri saklanıyor, 3.
    -- program üretilince en eski hafta siliniyor.
    hafta_no integer
);

create index idx_homeworks_teacher_id on public.homeworks(teacher_id);
create index idx_homeworks_student_id on public.homeworks(student_id);

-- ==========================================
-- 5. VIDEO_DERSLER (Premium Video Laboratuvarı)
-- ==========================================
create table public.video_dersler (
    id uuid primary key default gen_random_uuid(),
    teacher_id uuid references public.profiles(id) on delete set null,
    ders text not null,
    title text not null,
    teacher text not null,
    video_id text not null,
    tarih timestamptz not null default now()
);

-- ==========================================
-- 6. VIDEO_NOTLARI
-- ==========================================
create table public.video_notlari (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    ders text,
    video_id text,
    video_baslik text,
    not_baslik text,
    not_metni text,
    tarih timestamptz not null default now()
);

create index idx_video_notlari_user_id on public.video_notlari(user_id);

-- ==========================================
-- 7. DESTEK_TALEPLERI
-- ==========================================
create table public.destek_talepleri (
    id uuid primary key default gen_random_uuid(),
    ad text,
    email text not null,
    konu text default 'Genel',
    mesaj text not null,
    user_id uuid references public.profiles(id) on delete set null,
    tarih timestamptz not null default now(),
    durum text not null default 'yeni'
);

-- ==========================================
-- SESSIONS (express-session deposu)
-- ==========================================
-- Mevcut cookie tabanlı oturum mimarisini koruyoruz (Supabase Auth sadece
-- e-posta/şifre DOĞRULAMASI için kullanılıyor); oturumun kendisi hâlâ
-- server.js'deki express-session ile yönetiliyor, sadece deposu artık
-- Firestore değil burası - böylece sunucu yeniden başlasa bile (deploy,
-- Render restart) oturumlar hayatta kalmaya devam ediyor.
create table public.sessions (
    sid text primary key,
    session jsonb not null,
    expires timestamptz not null
);

create index idx_sessions_expires on public.sessions(expires);

-- ==========================================
-- ROW LEVEL SECURITY
-- ==========================================
-- Backend (server.js) Supabase'e SERVICE ROLE anahtarıyla bağlanacak -
-- bu anahtar RLS'i tamamen bypass eder (tıpkı firebase-admin'in Firestore
-- güvenlik kurallarını bypass etmesi gibi). Yani mevcut mimaride tüm
-- yetkilendirme mantığı zaten server.js içinde duruyor ve öyle kalıyor.
-- RLS'i yine de açıyoruz ki anon/public anahtarla YANLIŞLIKLA doğrudan
-- istemciden erişim denenirse hiçbir şey sızmasın.
alter table public.profiles enable row level security;
alter table public.analizler enable row level security;
alter table public.wrong_questions enable row level security;
alter table public.homeworks enable row level security;
alter table public.video_dersler enable row level security;
alter table public.video_notlari enable row level security;
alter table public.destek_talepleri enable row level security;
alter table public.sessions enable row level security;

-- Herkes kendi profilini okuyabilsin (opsiyonel - ileride istemci taraflı
-- Supabase kullanımı için hazır bulunsun diye eklendi, server.js zaten
-- service_role ile bunu bypass ediyor).
create policy "Kullanıcılar kendi profilini görebilir"
    on public.profiles for select
    using (auth.uid() = id);

-- Video dersleri herkese (giriş yapmış kullanıcılara) açık okunabilir.
create policy "Giriş yapan herkes video derslerini görebilir"
    on public.video_dersler for select
    using (auth.role() = 'authenticated');

-- ==========================================
-- YENİ KULLANICI KAYDI TETİKLEYİCİSİ
-- ==========================================
-- Supabase Auth'ta bir kullanıcı oluşturulduğunda (auth.users'a satır
-- eklendiğinde) otomatik olarak profiles tablosunda da bir satır açar.
-- server.js /register uçtan supabase.auth.admin.createUser() çağırırken
-- user_metadata içinde {ad, role, ...} gönderecek, bu trigger onu okuyup
-- profiles'a yazacak.
create or replace function public.handle_new_user()
returns trigger as $$
begin
    insert into public.profiles (id, ad, email, role, referral_code, kvkk_onay, sozlesme_onay, onay_tarihi)
    values (
        new.id,
        coalesce(new.raw_user_meta_data->>'ad', 'Kullanıcı'),
        new.email,
        coalesce(new.raw_user_meta_data->>'role', 'student'),
        'SS-' || upper(substr(md5(random()::text), 1, 6)),
        coalesce((new.raw_user_meta_data->>'kvkk_onay')::boolean, false),
        coalesce((new.raw_user_meta_data->>'sozlesme_onay')::boolean, false),
        now()
    );
    return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();

-- ==========================================
-- ADMIN_LOG (admin panelindeki işlemlerin denetim kaydı)
-- ==========================================
-- Admin panelinden Premium/Free değiştirme, rol değiştirme, hesap silme
-- gibi işlemler yapıldığında buraya bir satır ekleniyor - "yanlışlıkla
-- birini sildim" gibi durumlarda geriye dönük bakabilmek için.
create table public.admin_log (
    id uuid primary key default gen_random_uuid(),
    admin_email text not null,
    islem text not null,
    hedef_email text,
    detay text,
    tarih timestamptz not null default now()
);

create index idx_admin_log_tarih on public.admin_log(tarih);

alter table public.admin_log enable row level security;

-- ==========================================
-- AI_YORUMLARI (AI Koç'un ürettiği net analizi yorumları)
-- ==========================================
create table public.ai_yorumlari (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    analiz_id uuid references public.analizler(id) on delete set null,
    yorum text not null,
    tarih timestamptz not null default now()
);

create index idx_ai_yorumlari_user_id on public.ai_yorumlari(user_id);

alter table public.ai_yorumlari enable row level security;

-- ==========================================
-- AI_MESAJLAR (AI Koç V2 - gerçek sohbet geçmişi)
-- ==========================================
-- ai_yorumlari'nın (tek seferlik yorum) yerini alıyor - artık AI Koç bir
-- sohbet, tüm mesaj geçmişi burada tutuluyor. "okunmadi" alanı, öğrenci
-- yazmadan AI'nin kendiliğinden attığı proaktif mesajları (örn. "normalde
-- güçlü olduğun derste hata yaptın") rozetle göstermek için.
create table public.ai_mesajlar (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    rol text not null check (rol in ('user', 'ai')),
    mesaj text not null,
    okunmadi boolean not null default true,
    tarih timestamptz not null default now()
);

create index idx_ai_mesajlar_user_tarih on public.ai_mesajlar(user_id, tarih);

alter table public.ai_mesajlar enable row level security;

// Supabase bağlantısı - firebase-admin'in yerini alıyor.
// SERVICE ROLE anahtarıyla bağlanıyoruz (RLS'i bypass eder, tıpkı
// firebase-admin'in Firestore güvenlik kurallarını bypass etmesi gibi) -
// bu dosya SADECE sunucu tarafında (server.js) kullanılmalı, istemciye
// (tarayıcıya) asla gönderilmemeli.
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
        '[SUPABASE] SUPABASE_URL veya SUPABASE_SERVICE_ROLE_KEY tanımlı değil! ' +
        'Render\'da bu değerleri Environment sekmesinden tanımlayın, yerelde .env dosyasına ekleyin.'
    );
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);

// ÖNEMLİ: supabase.auth.signInWithPassword() çağrıldığı istemcinin iç oturum
// durumunu O KULLANICININ token'ına çeviriyor - bu, aynı istemciyi hem
// service_role hem de giriş doğrulaması için kullanırsak, o andan sonraki
// TÜM sorguların artık service_role değil, giriş yapan kullanıcının (RLS'e
// tabi) yetkisiyle çalışmasına yol açar. Bunu önlemek için sadece
// e-posta/şifre doğrulaması (signInWithPassword) için AYRI, anon-key'li bir
// istemci kullanıyoruz; ana `supabase` istemcisi hep saf service_role kalır.
const supabaseAuthClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);

module.exports = { supabase, supabaseAuthClient };

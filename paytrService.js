// Gerçek ödeme (Premium üyelik) - PayTR iFrame API entegrasyonu.
// iyzico'nun üye iş yeri kayıt sistemi geçici olarak sorunlu çıktığı için
// PayTR'e geçildi - mantık aynı: kart bilgisi bize gelmiyor, PayTR'in kendi
// barındırdığı iframe'i gömüyoruz (PCI-DSS kapsamı bizde değil).
//
// Render'da çalışması için ortam değişkenleri gerekli:
// PAYTR_MERCHANT_ID, PAYTR_MERCHANT_KEY, PAYTR_MERCHANT_SALT
// (https://www.paytr.com/magaza/kullanici-girisi > Destek & Kurulum >
// Entegrasyon Bilgileri altında görünüyor - üye iş yeri onayı gerekiyor.)

const crypto = require('crypto');

const merchantId = process.env.PAYTR_MERCHANT_ID || '';
const merchantKey = process.env.PAYTR_MERCHANT_KEY || '';
const merchantSalt = process.env.PAYTR_MERCHANT_SALT || '';
const TEST_MODE = process.env.PAYTR_TEST_MODE === 'true' ? '1' : '0';

const paytrAktif = !!(merchantId && merchantKey && merchantSalt);

if (!paytrAktif) {
    console.warn('[paytrService] PAYTR_MERCHANT_ID/KEY/SALT tanımlı değil. Gerçek ödeme devre dışı kalacak.');
}

function hmacBase64(dataStr) {
    return crypto.createHmac('sha256', merchantKey).update(dataStr).digest('base64');
}

/**
 * Kullanıcı için Premium ödeme iframe'ini başlatır.
 *
 * @param {object} girdi
 * @param {object} girdi.user - Supabase profiles satırı (id, ad, soyad, email).
 * @param {number} girdi.tutar - TL olarak fiyat (örn. 99.90).
 * @param {string} girdi.ip - Kullanıcının IP adresi.
 * @param {string} girdi.okUrl - Ödeme başarılı olunca yönlendirilecek adres.
 * @param {string} girdi.failUrl - Ödeme başarısız olunca yönlendirilecek adres.
 * @returns {Promise<{ basarili: boolean, token?: string, merchantOid?: string, mesaj?: string }>}
 */
async function odemeBaslat({ user, tutar, ip, okUrl, failUrl }) {
    if (!paytrAktif) return { basarili: false, mesaj: 'Ödeme sistemi şu an yapılandırılmamış.' };

    // Alfanumerik olmalı (tire/özel karakter YOK) - PayTR şartı.
    const merchantOid = 'SS' + crypto.randomUUID().replace(/-/g, '').slice(0, 24).toUpperCase();
    const paymentAmount = Math.round(tutar * 100); // kuruş cinsinden
    const email = user.email;
    const userName = `${user.ad || 'Kullanıcı'} ${user.soyad || ''}`.trim() || 'Kullanıcı';
    const userAddress = 'Türkiye - Dijital ürün, kargo yok';
    const userPhone = '05000000000';
    const userBasket = Buffer.from(JSON.stringify([
        ['SmartStudy Premium Üyelik', tutar.toFixed(2), 1]
    ])).toString('base64');
    const noInstallment = '0';
    const maxInstallment = '0';
    const currency = 'TL';

    // get-token için sıra: ...alanlar..., SONUNDA merchant_salt.
    const hashStr = merchantId + ip + merchantOid + email + String(paymentAmount) +
        userBasket + noInstallment + maxInstallment + currency + TEST_MODE;
    const paytrToken = hmacBase64(hashStr + merchantSalt);

    const body = new URLSearchParams({
        merchant_id: merchantId,
        user_ip: ip,
        merchant_oid: merchantOid,
        email,
        payment_amount: String(paymentAmount),
        paytr_token: paytrToken,
        user_basket: userBasket,
        debug_on: '1',
        no_installment: noInstallment,
        max_installment: maxInstallment,
        user_name: userName,
        user_address: userAddress,
        user_phone: userPhone,
        merchant_ok_url: okUrl,
        merchant_fail_url: failUrl,
        timeout_limit: '30',
        currency,
        test_mode: TEST_MODE,
        lang: 'tr'
    });

    try {
        const res = await fetch('https://www.paytr.com/odeme/api/get-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
        const sonuc = await res.json();

        if (sonuc.status !== 'success') {
            console.error('[paytrService] Token alma başarısız:', sonuc.reason || sonuc);
            return { basarili: false, mesaj: sonuc.reason || 'Ödeme başlatılamadı.' };
        }

        return { basarili: true, token: sonuc.token, merchantOid, paymentAmount };
    } catch (error) {
        console.error('[paytrService] Ödeme başlatma hatası:', error);
        return { basarili: false, mesaj: 'Ödeme başlatılamadı, birkaç dakika sonra tekrar dene.' };
    }
}

/**
 * PayTR'in bildirim (callback) isteğini doğrular. Bu istek PayTR'in kendi
 * sunucusundan geldiği İDDİA ediliyor - gerçekten onlardan geldiğini
 * kanıtlamak için hash'i kendimiz yeniden hesaplayıp karşılaştırıyoruz.
 * Bu doğrulama olmadan biri sahte bir bildirim gönderip ücretsiz Premium
 * alabilir.
 *
 * @param {object} govde - req.body (merchant_oid, status, total_amount, hash, ...)
 * @returns {{ basarili: boolean, merchantOid: string, durum: string, hashDogruMu: boolean }}
 */
function bildirimDogrula(govde) {
    const { merchant_oid: merchantOid, status, total_amount: totalAmount, hash } = govde;
    // Bildirim doğrulaması için sıra get-token'dan FARKLI: salt burada
    // merchant_oid'den hemen sonra geliyor, sonda değil.
    const beklenenHash = hmacBase64(merchantOid + merchantSalt + status + totalAmount);
    const hashDogruMu = beklenenHash === hash;

    return {
        basarili: hashDogruMu && status === 'success',
        merchantOid,
        durum: status,
        hashDogruMu
    };
}

module.exports = { odemeBaslat, bildirimDogrula, paytrAktif };

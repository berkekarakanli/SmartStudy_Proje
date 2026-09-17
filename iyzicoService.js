// Gerçek ödeme (Premium üyelik) - iyzico Checkout Form entegrasyonu.
//
// Neden Checkout Form: Kart numarası/CVV gibi bilgiler HİÇBİR ZAMAN bizim
// sunucumuza gelmiyor - iyzico'nun kendi barındırdığı ödeme formunu
// gömüyoruz, kullanıcı kart bilgisini doğrudan iyzico'ya giriyor. Bu sayede
// PCI-DSS (kart verisi güvenliği) yükümlülüğü bizim üzerimizde değil,
// iyzico'da kalıyor - kendi kart işleme kodu yazmamız hem güvenlik riski
// hem de gereksiz bir yük olurdu.
//
// Render'da çalışması için ortam değişkenleri gerekli:
// IYZICO_API_KEY, IYZICO_SECRET_KEY, IYZICO_BASE_URL
// (sandbox: https://sandbox-api.iyzipay.com, canlıya geçince:
// https://api.iyzipay.com - https://sandbox-merchant.iyzipay.com/auth/register
// adresinden ücretsiz bir sandbox hesabı açıp API Key/Secret Key alınabilir,
// gerçek para tahsil etmek için ayrıca üye iş yeri onayı gerekiyor.)

const Iyzipay = require('iyzipay');
const crypto = require('crypto');

const apiKey = process.env.IYZICO_API_KEY || '';
const secretKey = process.env.IYZICO_SECRET_KEY || '';
const baseUrl = process.env.IYZICO_BASE_URL || 'https://sandbox-api.iyzipay.com';

const iyzipay = apiKey && secretKey ? new Iyzipay({ apiKey, secretKey, uri: baseUrl }) : null;

if (!iyzipay) {
    console.warn('[iyzicoService] IYZICO_API_KEY/IYZICO_SECRET_KEY tanımlı değil. Gerçek ödeme devre dışı kalacak.');
}

function hmacHesapla(parcalar) {
    return crypto.createHmac('sha256', secretKey).update(parcalar.join(':')).digest('hex');
}

/**
 * Kullanıcı için Premium ödeme formunu başlatır - iyzico'nun kendi
 * barındırdığı Checkout Form'un HTML/script içeriğini döner, bu içerik
 * doğrudan sayfaya gömülür.
 *
 * @param {object} girdi
 * @param {object} girdi.user - Supabase profiles satırı (id, ad, soyad, email).
 * @param {number} girdi.tutar - TL olarak fiyat (örn. 99.90).
 * @param {string} girdi.callbackUrl - Ödeme tamamlanınca iyzico'nun POST edeceği adres.
 * @param {string} girdi.ip - Kullanıcının IP adresi (iyzico dolandırıcılık kontrolü için zorunlu tutuyor).
 * @returns {Promise<{ basarili: boolean, checkoutFormContent?: string, conversationId?: string, mesaj?: string }>}
 */
function odemeBaslat({ user, tutar, callbackUrl, ip }) {
    return new Promise((resolve) => {
        if (!iyzipay) {
            return resolve({ basarili: false, mesaj: 'Ödeme sistemi şu an yapılandırılmamış.' });
        }

        const conversationId = crypto.randomUUID();
        const fiyatMetni = tutar.toFixed(2);
        // AÇIK NOKTA: iyzico'nun buyer.identityNumber alanı zorunlu ama biz
        // kayıt formunda öğrencinin TC kimlik numarasını toplamıyoruz (bunu
        // istemek hem KVKK açısından gereksiz bir veri toplama olur hem de
        // kayıt formunu ağırlaştırır). Şimdilik iyzico'nun kendi resmi örnek
        // kodunda kullandığı sabit değeri koyduk - bu sandbox'ta çalışıyor,
        // ama GERÇEK/canlı ortamda iyzico'nun bunu kabul edip etmeyeceği
        // doğrulanmadı. Canlıya geçmeden önce iyzico destek ekibine sorulmalı
        // ya da gerekirse ödeme formuna bir TC kimlik alanı eklenmeli.
        const identityNumber = '74300864791';
        const adSoyad = `${user.ad || 'Kullanıcı'} ${user.soyad || ''}`.trim();

        const request = {
            locale: Iyzipay.LOCALE.TR,
            conversationId,
            price: fiyatMetni,
            paidPrice: fiyatMetni,
            currency: Iyzipay.CURRENCY.TRY,
            basketId: 'PREMIUM-' + user.id,
            paymentGroup: Iyzipay.PAYMENT_GROUP.SUBSCRIPTION,
            callbackUrl,
            buyer: {
                id: user.id,
                name: user.ad || 'Kullanıcı',
                surname: user.soyad || '-',
                gsmNumber: '+905000000000',
                email: user.email,
                identityNumber,
                registrationAddress: 'Türkiye',
                ip: ip || '85.34.78.112',
                city: 'Istanbul',
                country: 'Turkey',
                zipCode: '34000'
            },
            shippingAddress: {
                contactName: adSoyad || 'Kullanıcı',
                city: 'Istanbul',
                country: 'Turkey',
                address: 'Dijital ürün - kargo yok',
                zipCode: '34000'
            },
            billingAddress: {
                contactName: adSoyad || 'Kullanıcı',
                city: 'Istanbul',
                country: 'Turkey',
                address: 'Dijital ürün - kargo yok',
                zipCode: '34000'
            },
            basketItems: [
                {
                    id: 'SMARTSTUDY-PREMIUM',
                    name: 'SmartStudy Premium Üyelik',
                    category1: 'Dijital Üyelik',
                    itemType: Iyzipay.BASKET_ITEM_TYPE.VIRTUAL,
                    price: fiyatMetni
                }
            ]
        };

        iyzipay.checkoutFormInitialize.create(request, (err, result) => {
            if (err) {
                console.error('[iyzicoService] Ödeme başlatma hatası:', err);
                return resolve({ basarili: false, mesaj: 'Ödeme başlatılamadı, birkaç dakika sonra tekrar dene.' });
            }
            if (result.status !== 'success') {
                console.error('[iyzicoService] iyzico başlatma başarısız:', result.errorMessage || result);
                return resolve({ basarili: false, mesaj: result.errorMessage || 'Ödeme başlatılamadı.' });
            }

            const imzaDogru = hmacHesapla([result.conversationId, result.token]) === result.signature;
            if (!imzaDogru) {
                console.error('[iyzicoService] Başlatma imzası doğrulanamadı - sahte/bozuk yanıt olabilir.');
                return resolve({ basarili: false, mesaj: 'Ödeme başlatılamadı (doğrulama hatası).' });
            }

            resolve({
                basarili: true,
                checkoutFormContent: result.checkoutFormContent,
                token: result.token,
                conversationId: result.conversationId
            });
        });
    });
}

/**
 * iyzico callback'inden gelen token ile ödemenin GERÇEKTEN başarılı olup
 * olmadığını iyzico'ya sorup doğrular - callback isteğinin kendisi asla
 * güvenilir kabul edilmez (biri sahte bir callback isteği gönderebilir),
 * bu yüzden mutlaka iyzico'nun retrieve API'siyle teyit edilir + HMAC
 * imzası kontrol edilir.
 *
 * @param {string} token
 * @returns {Promise<{ basarili: boolean, paymentStatus?: string, tutar?: number, hamYanit?: object }>}
 */
function odemeDogrula(token) {
    return new Promise((resolve) => {
        if (!iyzipay) return resolve({ basarili: false });

        iyzipay.checkoutForm.retrieve({ locale: Iyzipay.LOCALE.TR, token }, (err, result) => {
            if (err) {
                console.error('[iyzicoService] Ödeme doğrulama hatası:', err);
                return resolve({ basarili: false });
            }
            if (result.status !== 'success') {
                return resolve({ basarili: false, hamYanit: result });
            }

            const beklenenImza = hmacHesapla([
                result.paymentStatus, result.paymentId, result.currency, result.basketId,
                result.conversationId, result.paidPrice, result.price, result.token
            ]);
            if (beklenenImza !== result.signature) {
                console.error('[iyzicoService] Doğrulama imzası uyuşmuyor - bu yanıta güvenilmiyor.');
                return resolve({ basarili: false, hamYanit: result });
            }

            resolve({
                basarili: result.paymentStatus === 'SUCCESS',
                paymentStatus: result.paymentStatus,
                tutar: Number(result.paidPrice),
                conversationId: result.conversationId,
                hamYanit: result
            });
        });
    });
}

module.exports = { odemeBaslat, odemeDogrula, iyzicoAktif: !!iyzipay };

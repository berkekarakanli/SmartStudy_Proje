// Yapay zeka (Gemini) ile optik/sonuç belgesi okuma servisi.
//
// Şöhretler Salonu (leaderboard) sadece yapay zeka tarafından doğrulanan
// belgelerle güncelleniyor. Bu yüzden burada GERÇEK bir belge okuma
// olmadan sahte/uydurma bir net değeri asla üretilmez: API anahtarı yoksa
// ya da belge okunamazsa fonksiyon `null` döner ve çağıran taraf kullanıcıya
// net bir hata mesajı gösterir.
//
// Render'da çalışması için ortam değişkeni olarak GEMINI_API_KEY tanımlı
// olmalı (https://aistudio.google.com/apikey adresinden alınabilir).

const { GoogleGenAI } = require('@google/genai');

const apiKey = process.env.GEMINI_API_KEY || '';
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

if (!apiKey) {
    console.warn('[geminiService] GEMINI_API_KEY tanımlı değil. Optik belge doğrulama (leaderboard) devre dışı kalacak.');
}

/**
 * Bir sınav sonuç belgesi / optik cevap kağıdı fotoğrafından (base64) toplam
 * net puanını okumaya çalışır.
 * @param {string} base64Image - "data:image/jpeg;base64,..." ya da saf base64.
 * @returns {Promise<number|null>} Bulunan net değeri, ya da okunamadıysa null.
 */
async function readNetFromOpticImage(base64Image) {
    if (!ai || !base64Image) return null;

    try {
        const cleanBase64 = base64Image.includes(',') ? base64Image.split(',').pop() : base64Image;

        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: [{
                role: 'user',
                parts: [
                    {
                        text: 'Bu görsel bir sınav (TYT/AYT/KPSS) sonuç belgesi veya optik cevap kağıdıdır. ' +
                            'Belgedeki TOPLAM NET puanını bul ve SADECE sayıyı yaz (örn: 87.50). ' +
                            'Net puanını güvenilir şekilde belirleyemiyorsan sadece "BULUNAMADI" yaz. ' +
                            'Başka hiçbir açıklama, birim veya cümle ekleme.'
                    },
                    { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } }
                ]
            }]
        });

        const text = String(
            response?.text ?? response?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
        ).trim();

        const match = text.match(/-?\d+([.,]\d+)?/);
        if (!match) return null;

        const net = Number(match[0].replace(',', '.'));
        return Number.isFinite(net) && net >= 0 ? net : null;
    } catch (error) {
        console.error('[geminiService] Gemini optik okuma hatası:', error?.message || error);
        return null;
    }
}

module.exports = { readNetFromOpticImage };

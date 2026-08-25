
const { GenerativeAI } = require('@google/generative-ai');



// Gemini API anahtarınızı buraya ekleyin

const apiKey = 'YOUR_GOOGLE_GENERATIVE_AI_API_KEY';



const geminiClient = new GenerativeAI(apiKey);



async function generateWorkoutPlan(netValues) {

    try {

        const response = await geminiClient.generateContent({

            model: 'gemini-pro',

            prompt: {

                textPrompt: {

                    text: `Öğrencinin sınav netleri: ${JSON.stringify(netValues)}\n\nEksik konular ve çalışma brifingi
oluşturun.`

                }

            },

            maxOutputTokens: 1024

        });



        if (response.content.length > 0) {

            return response.content[0].parts[0].text;

        } else {

            throw new Error('Gemini API yanıtında içerik bulunamadı.');

        }

    } catch (error) {

        console.error('Gemini API hatası:', error);

        throw error;

    }

}



module.exports = { generateWorkoutPlan };

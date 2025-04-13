const AWS = require('aws-sdk');
const translate = new AWS.Translate();
const dynamodb = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  try {
    // Parse the incoming request
    const body = JSON.parse(event.body);
    const imageKey = body.imageKey;
    const language = body.language || 'en'; // Default to English
    
    // Temporarily mock landmark detection
    const rekognitionResult = {
      isLandmark: true,
      landmarkName: 'Eiffel Tower',
      detectedLabels: [
        { name: 'Tower', confidence: 95 },
        { name: 'Architecture', confidence: 90 }
      ]
    };
    
    // Log the mock rekognition result for debugging
    console.log('Mock Rekognition Result:', JSON.stringify(rekognitionResult, null, 2));
    
    if (!rekognitionResult.isLandmark) {
      return {
        statusCode: 404,
        headers: {
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ 
          message: 'No landmark detected in the image. Please upload a clear image of a well-known landmark.',
          detectedLabels: rekognitionResult.detectedLabels || []
        })
      };
    }
    
    // Get landmark information from DynamoDB
    const landmarkData = await dynamodb.get({
      TableName: process.env.LANDMARK_TABLE,
      Key: {
        LandmarkId: rekognitionResult.landmarkName
      }
    }).promise();
    
    let landmarkInfo;
    
    if (landmarkData.Item) {
      landmarkInfo = landmarkData.Item;
    } else {
      // Fallback data if landmark not in database
      landmarkInfo = {
        LandmarkId: rekognitionResult.landmarkName,
        name: rekognitionResult.landmarkName,
        location: 'Paris, France',
        yearBuilt: '1889',
        description: {
          en: 'The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France. It is named after the engineer Gustave Eiffel, whose company designed and built the tower.',
          fr: 'La Tour Eiffel est une tour de fer forgé située sur le Champ de Mars à Paris, en France. Elle porte le nom de l\'ingénieur Gustave Eiffel, dont l\'entreprise a conçu et construit la tour.'
        }
      };
    }
    
    // Get description in the requested language
    let description = landmarkInfo.description[language];
    
    // If the requested language is not available, translate the content
    if (!description && landmarkInfo.description.en) {
      const translateResult = await translateText(
        landmarkInfo.description.en, 
        'en', 
        language
      );
      
      description = translateResult.translatedText;
    }
    
    // Prepare the response
    const response = {
      landmarkName: landmarkInfo.name,
      location: landmarkInfo.location,
      yearBuilt: landmarkInfo.yearBuilt,
      description: description
    };
    
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(response)
    };
    
  } catch (error) {
    console.error('Error processing image:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ 
        message: 'Error processing image. Please try again.',
        error: error.message 
      })
    };
  }
};

/**
 * Translates text from source language to target language
 */
async function translateText(text, sourceLanguage, targetLanguage) {
  try {
    console.log(`Translating text from ${sourceLanguage} to ${targetLanguage}`);
    
    // If source and target languages are the same, return the original text
    if (sourceLanguage === targetLanguage) {
      return {
        translatedText: text,
        sourceLanguage,
        targetLanguage
      };
    }
    
    const params = {
      Text: text,
      SourceLanguageCode: sourceLanguage,
      TargetLanguageCode: targetLanguage
    };
    
    const result = await translate.translateText(params).promise();
    console.log('Translation result:', JSON.stringify(result, null, 2));
    
    return {
      translatedText: result.TranslatedText,
      sourceLanguage: result.SourceLanguageCode,
      targetLanguage: result.TargetLanguageCode
    };
    
  } catch (error) {
    console.error('Error in Amazon Translate:', error);
    throw error;
  }
}
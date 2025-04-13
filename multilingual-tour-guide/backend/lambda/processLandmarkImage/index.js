const AWS = require('aws-sdk');
const rekognition = new AWS.Rekognition();
const translate = new AWS.Translate();
const polly = new AWS.Polly();
const s3 = new AWS.S3();
const dynamodb = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  try {
    // Parse the incoming request
    const body = JSON.parse(event.body);
    const imageKey = body.imageKey;
    const language = body.language || 'en'; // Default to English
    
    // Get the bucket name from environment variables
    const bucketName = process.env.BUCKET_NAME;
    
    // Identify the landmark using Rekognition
    const rekognitionResult = await identifyLandmark(bucketName, imageKey);
    
    // Log the rekognition result for debugging
    console.log('Rekognition Result:', JSON.stringify(rekognitionResult, null, 2));
    
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
        location: 'Unknown',
        yearBuilt: 'Unknown',
        description: {
          en: `This appears to be ${rekognitionResult.landmarkName}.`,
          fr: `Cela semble être ${rekognitionResult.landmarkName}.`
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
    // *** COMMENTING OUT POLLY CODE START ***
    // Generate audio narration using Amazon Polly
    //const audioKey = `audio/${landmarkInfo.LandmarkId.replace(/\s+/g, '-').toLowerCase()}_${language}.mp3`;
    
    //const pollyResult = await generateAndSaveAudio(
    //  description,
    //  language,
    //  bucketName,
    //  audioKey
    //);
      // *** COMMENTING OUT POLLY CODE END ***
    // Prepare the response
    const response = {
      landmarkName: landmarkInfo.name,
      location: landmarkInfo.location,
      yearBuilt: landmarkInfo.yearBuilt,
      description: description,
      // *** COMMENTING OUT audioUrl ***
      // audioUrl: pollyResult.audioUrl
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
 * Identifies landmarks in an image stored in S3
 */
async function identifyLandmark(bucketName, imageKey) {
  try {
    console.log(`Identifying landmarks in image: ${imageKey} from bucket: ${bucketName}`);

    const labelParams = {
      Image: {
        S3Object: {
          Bucket: bucketName,
          Name: imageKey
        }
      },
      MaxLabels: 5,
      MinConfidence: 80
    };

    const labelResults = await rekognition.detectLabels(labelParams).promise();
    console.log('Full Label detection results:', JSON.stringify(labelResults, null, 2));

    const detectedLabels = labelResults.Labels.map(label => ({
      name: label.Name,
      confidence: label.Confidence
    }));
    console.log('Detected Labels:', JSON.stringify(detectedLabels, null, 2));

    // More comprehensive landmark detection using determineLandmarkFromLabels
    const landmarkName = determineLandmarkFromLabels(labelResults.Labels);
    const isLandmark = landmarkName !== 'Unknown Landmark';
    console.log('Landmark Identification Result:', { isLandmark, landmarkName });

    return {
      isLandmark: isLandmark,
      landmarkName: landmarkName,
      detectedLabels: detectedLabels
    };

  } catch (error) {
    console.error('Error in Rekognition landmark detection:', error);
    throw error;
  }
}

/**
 * Determine landmark name from detected labels
 * Enhanced landmark detection logic
 */
/**
 * Determine landmark name from detected labels
 * Enhanced landmark detection logic
 */
/**
 * Determine landmark name from detected labels
 * Enhanced landmark detection logic
 */
function determineLandmarkFromLabels(labels) {
  // Create a map of labels for easier checking (optional but can be helpful)
  const labelMap = new Set(labels.map(l => l.Name));

  // Directly check for "Statue of Liberty" with sufficient confidence
  const statueOfLibertyLabel = labels.find(label => label.Name === 'Statue of Liberty' && label.Confidence >= 80);
  if (statueOfLibertyLabel) {
    return 'Statue of Liberty';
  }

  // Landmark detection rules with multiple indicators and confidence thresholds
  const landmarkRules = [
    {
      name: 'Eiffel Tower',
      indicators: ['Tower', 'Architecture'],
      confidenceThreshold: 80, // Require higher confidence for key indicators
      additionalChecks: (labels) => labels.some(l => l.Name === 'Paris' && l.Confidence > 70) || labels.some(l => l.Name === 'France' && l.Confidence > 70),
    },
    {
      name: 'Colosseum',
      indicators: ['Amphitheater', 'Ruins'],
      confidenceThreshold: 75,
      additionalChecks: (labels) => labels.some(l => l.Name === 'Rome' && l.Confidence > 70) || labels.some(l => l.Name === 'Italy' && l.Confidence > 70),
    },
    {
      name: 'Great Pyramid of Giza',
      indicators: ['Pyramid'],
      confidenceThreshold: 80,
      additionalChecks: (labels) => labels.some(l => l.Name === 'Egypt' && l.Confidence > 70) || labels.some(l => l.Name === 'Giza' && l.Confidence > 70),
    },
    {
      name: 'Neuschwanstein Castle',
      indicators: ['Castle'],
      confidenceThreshold: 80,
      additionalChecks: (labels) => labels.some(l => l.Name === 'Bavaria' && l.Confidence > 70) || labels.some(l => l.Name === 'Germany' && l.Confidence > 70),
    },
    // Add more landmark rules here
  ];

  for (const rule of landmarkRules) {
    const hasSufficientConfidence = rule.indicators.every(indicator =>
      labels.some(l => l.Name === indicator && l.Confidence >= rule.confidenceThreshold)
    );

    const passesAdditionalChecks = rule.additionalChecks ? rule.additionalChecks(labels) : true;

    if (hasSufficientConfidence && passesAdditionalChecks) {
      return rule.name;
    }
  }

  return 'Unknown Landmark';
}

// Rest of the code (translateText and generateAndSaveAudio functions) remains the same
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

/**
 * Generates speech and saves it to S3
 */
async function generateAndSaveAudio(text, language, bucketName, objectKey) {
  try {
    console.log(`Generating audio for "${text.substring(0, 50)}..." in ${language}`);
    
    // Select appropriate voice based on language
    let voiceId;
    switch (language) {
      case 'fr':
        voiceId = 'Mathieu'; // Male French voice
        break;
      case 'en':
      default:
        voiceId = 'Matthew'; // Male English voice
        break;
    }
    
    const params = {
      OutputFormat: 'mp3',
      Text: text,
      TextType: 'text',
      VoiceId: voiceId
    };
    
    const result = await polly.synthesizeSpeech(params).promise();
    console.log('Speech synthesis completed');
    
    // Upload audio to S3
    await s3.putObject({
      Bucket: bucketName,
      Key: objectKey,
      Body: result.AudioStream,
      ContentType: 'audio/mpeg'
    }).promise();
    
    console.log(`Audio saved to s3://${bucketName}/${objectKey}`);
    
    // Generate a pre-signed URL for the audio file
    const audioUrl = s3.getSignedUrl('getObject', {
      Bucket: bucketName,
      Key: objectKey,
      Expires: 3600 // URL expires in 1 hour
    });
    
    return {
      audioUrl,
      language,
      objectKey,
      bucketName
    };
    
  } catch (error) {
    console.error('Error generating and saving audio:', error);
    throw error;
  }
}

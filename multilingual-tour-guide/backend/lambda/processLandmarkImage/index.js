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
    
    if (!rekognitionResult.isLandmark) {
      return {
        statusCode: 404,
        headers: {
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ message: 'No landmark detected in the image' })
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
    
    // Generate audio narration using Amazon Polly
    const audioKey = `audio/${landmarkInfo.LandmarkId.replace(/\s+/g, '-').toLowerCase()}_${language}.mp3`;
    
    const pollyResult = await generateAndSaveAudio(
      description,
      language,
      bucketName,
      audioKey
    );
    
    // Prepare the response
    const response = {
      landmarkName: landmarkInfo.name,
      location: landmarkInfo.location,
      yearBuilt: landmarkInfo.yearBuilt,
      description: description,
      audioUrl: pollyResult.audioUrl
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
      body: JSON.stringify({ message: 'Error processing image', error: error.message })
    };
  }
};

/**
 * Identifies landmarks in an image stored in S3
 */
async function identifyLandmark(bucketName, imageKey) {
  try {
    console.log(`Identifying landmarks in image: ${imageKey} from bucket: ${bucketName}`);
    
    // First try detectLabels to identify if the image contains landmarks/buildings
    const labelParams = {
      Image: {
        S3Object: {
          Bucket: bucketName,
          Name: imageKey
        }
      },
      MaxLabels: 10,
      MinConfidence: 70
    };
    
    const labelResults = await rekognition.detectLabels(labelParams).promise();
    console.log('Label detection results:', JSON.stringify(labelResults, null, 2));
    
    // Check if any landmark-related labels are detected
    const landmarkLabels = ['Architecture', 'Building', 'Monument', 'Tower', 'Landmark', 'Castle', 'Statue'];
    const isLandmarkImage = labelResults.Labels.some(label => 
      landmarkLabels.includes(label.Name) && label.Confidence > 70
    );
    
    if (!isLandmarkImage) {
      console.log('No landmark-related objects detected in the image');
      return { 
        isLandmark: false,
        message: 'No landmark detected in the image'
      };
    }
    
    // For this implementation, we'll use the detected labels to make an educated guess
    let landmarkName = determineLandmarkFromLabels(labelResults.Labels);
    
    return {
      isLandmark: true,
      landmarkName: landmarkName,
      confidence: 85.5 // Simulated confidence score
    };
    
  } catch (error) {
    console.error('Error in Rekognition landmark detection:', error);
    throw error;
  }
}

/**
 * Determine landmark name from detected labels
 * This is a simplified approach - in a production environment,
 * you would use more sophisticated landmark detection
 */
function determineLandmarkFromLabels(labels) {
  if (labels.some(l => l.Name === 'Tower' && l.Confidence > 80)) {
    return 'Eiffel Tower';
  } else if (labels.some(l => l.Name === 'Statue' && l.Confidence > 80)) {
    return 'Statue of Liberty';
  } else if (labels.some(l => l.Name === 'Colosseum' && l.Confidence > 80)) {
    return 'Colosseum';
  } else if (labels.some(l => l.Name === 'Pyramid' && l.Confidence > 80)) {
    return 'Great Pyramid of Giza';
  } else if (labels.some(l => l.Name === 'Castle' && l.Confidence > 80)) {
    return 'Neuschwanstein Castle';
  } else {
    return 'Unknown Landmark';
  }
}

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

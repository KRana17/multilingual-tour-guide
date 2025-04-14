const AWS = require('aws-sdk');
const rekognition = new AWS.Rekognition();
const translate = new AWS.Translate();
const polly = new AWS.Polly();
const s3 = new AWS.S3();
const dynamodb = new AWS.DynamoDB.DocumentClient();
const cloudwatch = new AWS.CloudWatch(); // Add CloudWatch service object

function normalizeLandmarkName(name) {
  if (!name) {
    return ''; // Handle null or undefined input
  }
  return name.toLowerCase().replace(/\s+/g, '');
}


function determinePrimaryLandmarkLabel(labels) {
  // First, look for exact matches of well-known landmarks with high confidence
  const specificLandmarks = labels.filter(label =>
    ['Eiffel Tower', 'Statue Of Liberty', 'Colosseum', /* Add more specific names */].includes(label.Name) && label.Confidence > 90 // Adjust confidence threshold if needed
  );

  if (specificLandmarks.length > 0) {
    return specificLandmarks.reduce((prev, current) => (prev.Confidence > current.Confidence) ? prev : current);
  }

  // Then, consider landmarks based on keywords and high confidence
  const landmarkKeywords = ['Tower', 'Bridge', 'Castle', 'Pyramid', 'Amphitheater', 'Statue', 'Temple', 'Opera House', 'Wall'];
  const highConfidenceLandmarks = labels.filter(label =>
    landmarkKeywords.some(keyword => label.Name.toLowerCase().includes(keyword.toLowerCase())) && label.Confidence > 80
  );

  if (highConfidenceLandmarks.length > 0) {
    return highConfidenceLandmarks.reduce((prev, current) => (prev.Confidence > current.Confidence) ? prev : current);
  }

  // If no specific or keyword-based high-confidence landmarks, return the highest confidence label overall
  if (labels.length > 0) {
    return labels.reduce((prev, current) => (prev.Confidence > current.Confidence) ? prev : current);
  }

  return null;
}

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
      MaxLabels: 10,
      MinConfidence: 70
    };

    const labelResults = await rekognition.detectLabels(labelParams).promise();
    console.log('Full Label detection results:', JSON.stringify(labelResults, null, 2));

    const detectedLabels = labelResults.Labels.map(label => ({
      name: label.Name,
      confidence: label.Confidence
    }));
    console.log('Detected Labels:', JSON.stringify(detectedLabels, null, 2));

    let normalizedLandmarkName = 'unknownlandmark';
    let isLandmarkDetected = false;
    let rawLandmarkName = null;

    const primaryLandmarkLabel = determinePrimaryLandmarkLabel(labelResults.Labels);

    if (primaryLandmarkLabel) {
      rawLandmarkName = primaryLandmarkLabel.Name;
      normalizedLandmarkName = normalizeLandmarkName(rawLandmarkName);
      isLandmarkDetected = normalizedLandmarkName !== 'unknownlandmark';
      console.log('Primary Landmark Label:', rawLandmarkName, 'Normalized:', normalizedLandmarkName);
    }

    return {
      isLandmark: isLandmarkDetected,
      landmarkName: normalizedLandmarkName,
      rawLandmarkName: rawLandmarkName, // Return the raw name for potential logging/debugging
      detectedLabels: detectedLabels
    };

  } catch (error) {
    console.error('Error in Rekognition landmark detection:', error);
    throw error;
  }
}

/**
 * Translates text from source language to target language
 */
async function translateText(text, sourceLanguage, targetLanguage) {
  try {
    console.log(`Translating text from ${sourceLanguage} to ${targetLanguage}`);

    if (sourceLanguage === targetLanguage) {
      return { translatedText: text, sourceLanguage, targetLanguage };
    }

    const params = {
      Text: text,
      SourceLanguageCode: sourceLanguage,
      TargetLanguageCode: targetLanguage
    };

    const result = await translate.translateText(params).promise();
    console.log('Translation result:', JSON.stringify(result, null, 2));

    return { translatedText: result.TranslatedText, sourceLanguage: result.SourceLanguageCode, targetLanguage: result.TargetLanguageCode };

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

    let voiceId;
    switch (language) {
      case 'fr': voiceId = 'Mathieu'; break;
      case 'en': default: voiceId = 'Matthew'; break;
    }

    const params = {
      OutputFormat: 'mp3',
      Text: text,
      TextType: 'text',
      VoiceId: voiceId
    };

    const result = await polly.synthesizeSpeech(params).promise();
    console.log('Speech synthesis completed');

    await s3.putObject({ Bucket: bucketName, Key: objectKey, Body: result.AudioStream, ContentType: 'audio/mpeg' }).promise();
    console.log(`Audio saved to s3://${bucketName}/${objectKey}`);

    const audioUrl = s3.getSignedUrl('getObject', { Bucket: bucketName, Key: objectKey, Expires: 3600 });

    return { audioUrl, language, objectKey, bucketName };

  } catch (error) {
    console.error('Error generating and saving audio:', error);
    throw error;
  }
}

exports.handler = async (event) => {
  console.log('Incoming event:', JSON.stringify(event, null, 2));

  try {
    const body = JSON.parse(event.body);
    const imageKey = body.imageKey;
    const language = body.language || 'en';

    console.log('Parsed body:', JSON.stringify(body, null, 2));
    console.log('Image Key:', imageKey);
    console.log('Language:', language);

    const bucketName = process.env.BUCKET_NAME;
    const landmarkTable = process.env.LANDMARK_TABLE;

    console.log('BUCKET_NAME:', bucketName);
    console.log('LANDMARK_TABLE:', landmarkTable);

    if (!bucketName || !landmarkTable) {
      console.error('Error: BUCKET_NAME or LANDMARK_TABLE environment variable not set.');
      return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'Internal server error.' }) };
    }

    const rekognitionResult = await identifyLandmark(bucketName, imageKey);
    console.log('Rekognition Result:', JSON.stringify(rekognitionResult, null, 2));

    if (!rekognitionResult.isLandmark) {
      return { statusCode: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'No landmark detected in the image. Please upload a clear image of a well-known landmark.', detectedLabels: rekognitionResult.detectedLabels || [] }) };
    }

    // Emit CloudWatch Metric for successful landmark identification
    try {
      await cloudwatch.putMetricData({
        Namespace: 'LandmarkApp',
        MetricData: [
          {
            MetricName: 'LandmarkRequestCount',
            Dimensions: [
              {
                Name: 'LandmarkName',
                Value: rekognitionResult.landmarkName
              },
            ],
            Unit: 'Count',
            Value: 1
          },
        ]
      }).promise();
      console.log('CloudWatch metric emitted successfully for:', rekognitionResult.landmarkName);
    } catch (cloudWatchError) {
      console.error('Error emitting CloudWatch metric:', cloudWatchError);
      // Non-critical error, continue processing
    }

    const normalizedLandmarkId = rekognitionResult.landmarkName; // Already normalized in identifyLandmark

    console.log('Attempting to retrieve data for LandmarkId:', normalizedLandmarkId);

    let landmarkData;
    try {
      landmarkData = await dynamodb.get({
        TableName: landmarkTable,
        Key: {
          LandmarkId: normalizedLandmarkId // Use the normalized name for the key
        }
      }).promise();
      console.log('DynamoDB Get Result:', JSON.stringify(landmarkData, null, 2));
    } catch (dynamoDbError) {
      console.error('Error during DynamoDB Get operation:', dynamoDbError);
      landmarkData = {};
    }

    let landmarkInfo;

    if (landmarkData.Item) {
      landmarkInfo = landmarkData.Item;
      console.log('Successfully retrieved landmark info from DynamoDB:', JSON.stringify(landmarkInfo, null, 2));
    } else {
      landmarkInfo = {
        LandmarkId: normalizedLandmarkId,
        name: rekognitionResult.rawLandmarkName || rekognitionResult.landmarkName, // Use raw name for fallback display
        location: 'Unknown',
        yearBuilt: 'Unknown',
        description: { en: `This appears to be ${rekognitionResult.rawLandmarkName || rekognitionResult.landmarkName}.`, fr: `Cela semble être ${rekognitionResult.rawLandmarkName || rekognitionResult.rawLandmarkName}.` }
      };
      console.log('Landmark not found in DynamoDB, using fallback data:', JSON.stringify(landmarkInfo, null, 2));
    }

    let description = landmarkInfo.description[language];

    if (!description && landmarkInfo.description.en) {
      const translateResult = await translateText(landmarkInfo.description.en, 'en', language);
      description = translateResult.translatedText;
      console.log('Translated description:', description);
    } else {
      console.log('Description in requested language:', description);
    }
    // *** COMMENTING OUT POLLY CODE START ***
    // const audioKey = `audio/${landmarkInfo.LandmarkId.replace(/\s+/g, '-').toLowerCase()}_${language}.mp3`;
    // const pollyResult = await generateAndSaveAudio(description, language, bucketName, audioKey);
    // *** COMMENTING OUT POLLY CODE END ***

    const response = {
      landmarkName: landmarkInfo.name,
      location: landmarkInfo.location,
      yearBuilt: landmarkInfo.yearBuilt,
      description: description,
      // *** COMMENTING OUT audioUrl ***
      // audioUrl: pollyResult.audioUrl
    };

    console.log('Final Response:', JSON.stringify(response, null, 2));

    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(response) };

  } catch (error) {
    console.error('Error processing image (outer catch):', error);
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'Error processing image. Please try again.', error: error.message }) };
  }
};
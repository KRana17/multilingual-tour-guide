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

/**
 * Calculate similarity score between two strings
 * @param {string} str1 - First string to compare
 * @param {string} str2 - Second string to compare
 * @returns {number} - Similarity score between 0 and 1
 */
function calculateSimilarity(str1, str2) {
  // Normalize both strings for comparison
  const normalizedStr1 = normalizeLandmarkName(str1);
  const normalizedStr2 = normalizeLandmarkName(str2);
  
  // Exact match
  if (normalizedStr1 === normalizedStr2) {
    return 1.0;
  }
  
  // Check if one string contains the other
  if (normalizedStr1.includes(normalizedStr2) || normalizedStr2.includes(normalizedStr1)) {
    // Calculate containment score based on length ratio
    const containmentScore = Math.min(normalizedStr1.length, normalizedStr2.length) / 
                             Math.max(normalizedStr1.length, normalizedStr2.length);
    return Math.max(0.7, containmentScore); // Minimum 0.7 score for containment
  }
  
  // Calculate word overlap for multi-word landmarks
  const words1 = normalizedStr1.split(/\W+/).filter(word => word.length > 0);
  const words2 = normalizedStr2.split(/\W+/).filter(word => word.length > 0);
  
  if (words1.length > 1 || words2.length > 1) {
    let matchCount = 0;
    for (const word1 of words1) {
      if (word1.length <= 2) continue; // Skip very short words
      for (const word2 of words2) {
        if (word2.length <= 2) continue; // Skip very short words
        if (word1 === word2 || word1.includes(word2) || word2.includes(word1)) {
          matchCount++;
          break;
        }
      }
    }
    
    const overlapScore = matchCount / Math.max(words1.length, words2.length);
    if (overlapScore > 0) {
      return Math.min(0.9, 0.5 + overlapScore * 0.4); // Scale between 0.5 and 0.9
    }
  }
  
  // Default low similarity
  return 0.0;
}

/**
 * Check if a label is related to landmarks or monuments
 * @param {string} label - Label to check
 * @returns {boolean} - True if label is related to landmarks
 */
function isLandmarkRelatedLabel(label) {
  const landmarkKeywords = [
    'landmark', 'monument', 'tower', 'statue', 'temple', 'palace', 
    'castle', 'cathedral', 'church', 'mosque', 'pyramid', 'ruins',
    'historical', 'heritage', 'ancient', 'architecture', 'wonder',
    'famous', 'tourist', 'attraction', 'site', 'building', 'structure'
  ];
  
  const normalizedLabel = normalizeLandmarkName(label);
  return landmarkKeywords.some(keyword => normalizedLabel.includes(keyword));
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
      MaxLabels: 15, // Increased from 10 to get more potential labels
      MinConfidence: 60 // Lowered from 70 to catch more potential matches
    };

    const labelResults = await rekognition.detectLabels(labelParams).promise();
    console.log('Full Label detection results:', JSON.stringify(labelResults, null, 2));

    const detectedLabels = labelResults.Labels.map(label => ({
      name: label.Name,
      confidence: label.Confidence
    }));
    console.log('Detected Labels:', JSON.stringify(detectedLabels, null, 2));

    // Define popular landmarks with alternative names and keywords
    const landmarkDefinitions = [
      {
        primaryName: "Eiffel Tower",
        alternativeNames: ["Tour Eiffel", "Iron Lady", "La Tour Eiffel"],
        keywords: ["paris", "france", "iron", "tower"]
      },
      {
        primaryName: "Statue of Liberty",
        alternativeNames: ["Liberty Enlightening the World", "Lady Liberty"],
        keywords: ["new york", "liberty island", "usa", "america"]
      },
      {
        primaryName: "Colosseum",
        alternativeNames: ["Coliseum", "Flavian Amphitheatre", "Roman Colosseum"],
        keywords: ["rome", "italy", "arena", "amphitheater", "gladiator"]
      },
      {
        primaryName: "Great Wall of China",
        alternativeNames: ["Great Wall", "Chinese Wall"],
        keywords: ["china", "wall", "beijing", "defense"]
      },
      {
        primaryName: "Machu Picchu",
        alternativeNames: ["Lost City of the Incas"],
        keywords: ["peru", "inca", "ruins", "andes"]
      },
      {
        primaryName: "Pyramids of Giza",
        alternativeNames: ["Great Pyramid", "Egyptian Pyramids", "Pyramid of Khufu"],
        keywords: ["egypt", "pyramid", "pharaoh", "cairo", "sphinx"]
      },
      {
        primaryName: "Taj Mahal",
        alternativeNames: ["Crown of Palaces"],
        keywords: ["india", "agra", "mausoleum", "marble", "mughal"]
      },
      {
        primaryName: "Big Ben",
        alternativeNames: ["Elizabeth Tower", "Clock Tower", "Westminster Clock"],
        keywords: ["london", "england", "uk", "parliament", "westminster", "clock"]
      },
      {
        primaryName: "Sydney Opera House",
        alternativeNames: ["Opera House"],
        keywords: ["sydney", "australia", "harbor", "theatre", "concert hall"]
      },
      {
        primaryName: "Mount Fuji",
        alternativeNames: ["Fujisan", "Fuji-san", "Fujiyama"],
        keywords: ["japan", "mountain", "volcano", "peak"]
      }
    ];

    // Extract all landmark names for simple matching
    const popularDestinations = landmarkDefinitions.map(def => def.primaryName);
    const allLandmarkNames = landmarkDefinitions.reduce((names, def) => {
      return [...names, def.primaryName, ...def.alternativeNames];
    }, []);

    // First pass: Check for exact matches with primary names
    for (const label of labelResults.Labels) {
      if (popularDestinations.includes(label.Name) && label.Confidence >= 75) {
        const normalizedName = normalizeLandmarkName(label.Name);
        console.log(`Exact match found for landmark: ${label.Name} with confidence ${label.Confidence}`);
        return {
          isLandmark: true,
          landmarkName: normalizedName,
          rawLandmarkName: label.Name,
          detectedLabels: detectedLabels,
          matchType: "exact",
          confidence: label.Confidence
        };
      }
    }

    // Second pass: Check for matches with alternative names
    for (const label of labelResults.Labels) {
      for (const landmarkDef of landmarkDefinitions) {
        if (landmarkDef.alternativeNames.includes(label.Name) && label.Confidence >= 75) {
          const normalizedName = normalizeLandmarkName(landmarkDef.primaryName);
          console.log(`Alternative name match found for landmark: ${label.Name} -> ${landmarkDef.primaryName} with confidence ${label.Confidence}`);
          return {
            isLandmark: true,
            landmarkName: normalizedName,
            rawLandmarkName: landmarkDef.primaryName,
            detectedLabels: detectedLabels,
            matchType: "alternative",
            confidence: label.Confidence
          };
        }
      }
    }

    // Third pass: Check for similarity matches
    let bestMatch = null;
    let bestScore = 0;
    let bestConfidence = 0;
    
    for (const label of labelResults.Labels) {
      if (label.Confidence < 70) continue; // Skip low confidence labels
      
      for (const landmarkDef of landmarkDefinitions) {
        // Check similarity with primary name
        let similarityScore = calculateSimilarity(label.Name, landmarkDef.primaryName);
        
        // Check similarity with alternative names
        for (const altName of landmarkDef.alternativeNames) {
          const altSimilarityScore = calculateSimilarity(label.Name, altName);
          if (altSimilarityScore > similarityScore) {
            similarityScore = altSimilarityScore;
          }
        }
        
        // Calculate combined score (similarity * confidence)
        const combinedScore = similarityScore * (label.Confidence / 100);
        
        if (similarityScore >= 0.7 && combinedScore > bestScore) {
          bestMatch = landmarkDef.primaryName;
          bestScore = combinedScore;
          bestConfidence = label.Confidence;
        }
      }
    }
    
    if (bestMatch) {
      const normalizedName = normalizeLandmarkName(bestMatch);
      console.log(`Similarity match found for landmark: ${bestMatch} with similarity score ${bestScore.toFixed(2)} and confidence ${bestConfidence}`);
      return {
        isLandmark: true,
        landmarkName: normalizedName,
        rawLandmarkName: bestMatch,
        detectedLabels: detectedLabels,
        matchType: "similarity",
        confidence: bestConfidence,
        similarityScore: bestScore
      };
    }

    // Fourth pass: Check for landmark-related labels with high confidence
    const landmarkLabels = labelResults.Labels.filter(label => 
      isLandmarkRelatedLabel(label.Name) && label.Confidence >= 85
    );
    
    if (landmarkLabels.length > 0) {
      // Find the highest confidence non-generic landmark label
      const nonGenericLabels = labelResults.Labels.filter(label => 
        !["Landmark", "Monument", "Architecture", "Building", "Structure"].includes(label.Name) && 
        label.Confidence >= 75
      );
      
      if (nonGenericLabels.length > 0) {
        // Sort by confidence
        nonGenericLabels.sort((a, b) => b.Confidence - a.Confidence);
        const bestLabel = nonGenericLabels[0];
        
        // Try to match with known landmarks
        let bestLandmarkMatch = null;
        let bestMatchScore = 0;
        
        for (const landmarkDef of landmarkDefinitions) {
          const similarityScore = calculateSimilarity(bestLabel.Name, landmarkDef.primaryName);
          if (similarityScore > bestMatchScore) {
            bestMatchScore = similarityScore;
            bestLandmarkMatch = landmarkDef.primaryName;
          }
          
          // Also check keywords
          const normalizedLabel = normalizeLandmarkName(bestLabel.Name);
          const keywordMatches = landmarkDef.keywords.filter(keyword => 
            normalizedLabel.includes(normalizeLandmarkName(keyword))
          );
          
          if (keywordMatches.length > 0 && keywordMatches.length / landmarkDef.keywords.length > bestMatchScore) {
            bestMatchScore = keywordMatches.length / landmarkDef.keywords.length;
            bestLandmarkMatch = landmarkDef.primaryName;
          }
        }
        
        if (bestLandmarkMatch && bestMatchScore >= 0.3) {
          const normalizedName = normalizeLandmarkName(bestLandmarkMatch);
          console.log(`Keyword/context match found for landmark: ${bestLandmarkMatch} based on label ${bestLabel.Name}`);
          return {
            isLandmark: true,
            landmarkName: normalizedName,
            rawLandmarkName: bestLandmarkMatch,
            detectedLabels: detectedLabels,
            matchType: "keyword",
            confidence: bestLabel.Confidence,
            matchScore: bestMatchScore
          };
        }
        
        // If we have a high confidence non-generic label that seems to be a landmark
        // but doesn't match our known landmarks, return it as an unknown landmark
        if (bestLabel.Confidence >= 85 && landmarkLabels.length >= 2) {
          const normalizedName = normalizeLandmarkName(bestLabel.Name);
          console.log(`Potential unknown landmark detected: ${bestLabel.Name} with confidence ${bestLabel.Confidence}`);
          return {
            isLandmark: true,
            landmarkName: normalizedName,
            rawLandmarkName: bestLabel.Name,
            detectedLabels: detectedLabels,
            matchType: "unknown",
            confidence: bestLabel.Confidence
          };
        }
      }
    }

    // No landmark detected
    console.log('No landmark detected in the image');
    return {
      isLandmark: false,
      landmarkName: "Unknown Landmark",
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
              {
                Name: 'MatchType',
                Value: rekognitionResult.matchType || 'unknown'
              }
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

    const normalizedLandmarkId = rekognitionResult.landmarkName;

    console.log('Attempting to retrieve data for LandmarkId:', normalizedLandmarkId);

    let landmarkData;
    try {
      landmarkData = await dynamodb.get({
        TableName: landmarkTable,
        Key: {
          LandmarkId: normalizedLandmarkId
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
        name: rekognitionResult.rawLandmarkName || rekognitionResult.landmarkName,
        location: 'Unknown',
        yearBuilt: 'Unknown',
        description: { en: `This appears to be ${rekognitionResult.rawLandmarkName || rekognitionResult.landmarkName}.`, fr: `Cela semble être ${rekognitionResult.rawLandmarkName || rekognitionResult.rawLandmarkName}.` },
        interestingFacts: { en: [], fr: [] }
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
      interestingFacts: landmarkInfo.interestingFacts ? (landmarkInfo.interestingFacts[language] || landmarkInfo.interestingFacts.en || []) : [],
      matchDetails: {
        matchType: rekognitionResult.matchType || 'unknown',
        confidence: rekognitionResult.confidence || 0,
        similarityScore: rekognitionResult.similarityScore || 0
      }
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

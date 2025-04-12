const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const { v4: uuidv4 } = require('uuid');

exports.handler = async (event) => {
  try {
    // Parse the incoming request
    const body = JSON.parse(event.body);
    const imageData = body.image; // Base64 encoded image
    const fileType = body.fileType || 'image/jpeg';
    
    // Decode the base64 image
    const buffer = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    
    // Generate a unique key for the image
    const imageKey = `uploads/${uuidv4()}.${fileType.split('/')[1]}`;
    
    // Get the bucket name from environment variables
    const bucketName = process.env.BUCKET_NAME;
    
    // Upload the image to S3
    await s3.putObject({
      Bucket: bucketName,
      Key: imageKey,
      Body: buffer,
      ContentType: fileType,
      ContentEncoding: 'base64'
    }).promise();
    
    // Generate a pre-signed URL for the uploaded image
    const imageUrl = s3.getSignedUrl('getObject', {
      Bucket: bucketName,
      Key: imageKey,
      Expires: 3600 // URL expires in 1 hour
    });
    
    // Return the image key and URL
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        imageKey: imageKey,
        imageUrl: imageUrl,
        message: 'Image uploaded successfully'
      })
    };
    
  } catch (error) {
    console.error('Error uploading image:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ message: 'Error uploading image', error: error.message })
    };
  }
};

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();

// Re-include the normalization function here for consistency
function normalizeLandmarkName(name) {
  if (!name) {
    return '';
  }
  return name.toLowerCase().trim().replace(/\s+/g, ''); // Use the same normalization as in your processing Lambda
}

exports.handler = async (event) => {
  const rawLandmarkName = "Eiffel Tower";
  const normalizedLandmarkId = normalizeLandmarkName(rawLandmarkName);

  const landmarkData = {
    LandmarkId: normalizedLandmarkId, // Use the normalized ID
    name: rawLandmarkName, // Keep the original name for display
    location: "Paris, France",
    yearBuilt: 1889,
    description: {
      en: "The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France. It is named after the engineer Gustave Eiffel, whose company designed and built the tower.",
      fr: "La Tour Eiffel est une tour de fer forgé située sur le Champ de Mars à Paris, en France. Elle porte le nom de l'ingénieur Gustave Eiffel, dont l'entreprise a conçu et construit la tour."
    },
    interestingFacts: {
      en: [
        "The Eiffel Tower was originally built as the entrance arch for the 1889 World's Fair in Paris to celebrate the 100th anniversary of the French Revolution.",
        "At 324 meters (1,063 feet) tall, it was the world's tallest man-made structure until the Chrysler Building in New York was completed in 1930.",
        "Gustave Eiffel designed the tower, but he didn't actually draw the plans. The detailed design was created by his senior engineers Maurice Koechlin and Émile Nouguier.",
        "During World War I, the Eiffel Tower played a crucial role in military communications, intercepting enemy radio communications.",
        "The tower is repainted every seven years, requiring about 60 tons of paint to protect it from corrosion. It changes color slightly with each repainting."
      ],
      fr: [
        "La Tour Eiffel a été initialement construite comme arc d'entrée de l'Exposition Universelle de 1889 à Paris pour célébrer le centenaire de la Révolution française.",
        "Haute de 324 mètres, elle était la structure la plus haute construite par l'homme jusqu'à la construction du Chrysler Building à New York en 1930.",
        "Gustave Eiffel a conçu la tour, mais il n'a pas réellement dessiné les plans. Les détails ont été créés par ses ingénieurs seniors Maurice Koechlin et Émile Nouguier.",
        "Pendant la Première Guerre mondiale, la Tour Eiffel a joué un rôle crucial dans les communications militaires, interceptant les communications radio ennemies.",
        "La tour est repeinte tous les sept ans, nécessitant environ 60 tonnes de peinture pour la protéger de la corrosion. Sa couleur change légèrement à chaque peinture."
      ]
    }
  };

  const params = {
    TableName: process.env.LANDMARK_TABLE, // Make sure to set this environment variable
    Item: landmarkData
  };

  try {
    await dynamodb.put(params).promise();

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Landmark successfully inserted',
        landmark: landmarkData.name
      })
    };
  } catch (error) {
    console.error('Error inserting landmark:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Failed to insert landmark',
        error: error.message
      })
    };
  }
};
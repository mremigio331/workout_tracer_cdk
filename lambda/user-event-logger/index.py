import os
import boto3
from datetime import datetime
from aws_lambda_powertools import Logger

# Set up structured logger
logger = Logger(service="user-signup")

dynamodb = boto3.client('dynamodb')
table_name = os.environ['TABLE_NAME']

@logger.inject_lambda_context
def handler(event, context):
    logger.info("POST_CONFIRMATION Lambda triggered.")

    if event['triggerSource'] == 'PostConfirmation_ConfirmSignUp':
        user_attrs = event['request']['userAttributes']
        logger.info(f"User attributes: {user_attrs}")

        user_id = user_attrs['sub']
        email = user_attrs.get('email')
        name = user_attrs.get('name', 'unknown')

        item = {
            'PK': {'S': f'#USER:{user_id}'},
            'SK': {'S': 'PROFILE'},
            'email': {'S': email},
            'name': {'S': name},
            'created_at': {'S': datetime.utcnow().isoformat()}
        }

        try:
            dynamodb.put_item(TableName=table_name, Item=item)
            logger.info(f"Added user to DynamoDB: {name}")
        except Exception as e:
            logger.error(f"Failed to write user to DynamoDB: {str(e)}")
    else:
        logger.warning(f"Unsupported triggerSource: {event['triggerSource']}")

    return event

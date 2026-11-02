from typing import Any
import argparse
import os
import asyncio
import logging
import base64
from email.message import EmailMessage
from email.header import decode_header
from base64 import urlsafe_b64decode
from email import message_from_bytes
import webbrowser

import mcp.types as types
from mcp.server import Server
import mcp.server.stdio


from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError


# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

EMAIL_ADMIN_PROMPTS = """You are an email administrator. 
You can draft, edit, read, trash, open, and send emails.
You've been given access to a specific gmail account. 
You have the following tools available:
- Send an email (send-email)
- Create a draft email (create-draft)
- List draft emails (list-drafts)
- Retrieve unread emails (get-unread-emails)
- Read email content (read-email)
- Trash email (trash-email)
- Open email in browser (open-email)
- List all labels (list-labels)
- Create a new label (create-label)
- Apply a label to an email (apply-label)
- Remove a label from an email (remove-label)
- Rename a label (rename-label)
- Delete a label (delete-label)
- Search for emails with a specific label (search-by-label)
- Search for emails using Gmail's search syntax (search-emails)
- List all email filters (list-filters)
- Get details of a specific filter (get-filter)
- Create a new email filter (create-filter)
- Delete a filter (delete-filter)
- Create a new folder (create-folder)
- Move an email to a folder (move-to-folder)
- List all folders (list-folders)
- Archive an email (archive-email)
- Batch archive emails (batch-archive)
- List archived emails (list-archived)
- Restore an email to inbox (restore-to-inbox)

Never send an email draft or trash an email unless the user confirms first. 
Always ask for approval if not already given.
"""

# Define available prompts
PROMPTS = {
    "manage-email": types.Prompt(
        name="manage-email",
        description="Act like an email administator",
        arguments=None,
    ),
    "draft-email": types.Prompt(
        name="draft-email",
        description="Draft an email with cotent and recipient",
        arguments=[
            types.PromptArgument(
                name="content",
                description="What the email is about",
                required=True
            ),
            types.PromptArgument(
                name="recipient",
                description="Who should the email be addressed to",
                required=True
            ),
            types.PromptArgument(
                name="recipient_email",
                description="Recipient's email address",
                required=True
            ),
        ],
    ),
    "edit-draft": types.Prompt(
        name="edit-draft",
        description="Edit the existing email draft",
        arguments=[
            types.PromptArgument(
                name="changes",
                description="What changes should be made to the draft",
                required=True
            ),
            types.PromptArgument(
                name="current_draft",
                description="The current draft to edit",
                required=True
            ),
        ],
    ),
    "manage-labels": types.Prompt(
        name="manage-labels",
        description="Manage email labels for organization",
        arguments=[
            types.PromptArgument(
                name="action",
                description="What action to take with labels (create, list, apply, remove, search)",
                required=True
            ),
        ],
    ),
    "manage-filters": types.Prompt(
        name="manage-filters",
        description="Manage email filters for automation",
        arguments=[
            types.PromptArgument(
                name="action",
                description="What action to take with filters (create, list, view, delete)",
                required=True
            ),
        ],
    ),
    "search-emails": types.Prompt(
        name="search-emails",
        description="Search for emails using Gmail's search syntax",
        arguments=[
            types.PromptArgument(
                name="query",
                description="What to search for in emails",
                required=True
            ),
        ],
    ),
    "manage-folders": types.Prompt(
        name="manage-folders",
        description="Manage email folders for organization",
        arguments=[
            types.PromptArgument(
                name="action",
                description="What action to take with folders (create, list, move)",
                required=True
            ),
        ],
    ),
    "manage-archive": types.Prompt(
        name="manage-archive",
        description="Manage archived emails",
        arguments=[
            types.PromptArgument(
                name="action",
                description="What action to take with archives (archive, batch-archive, list, restore)",
                required=True
            ),
        ],
    ),
}


def decode_mime_header(header: str) -> str: 
    """Helper function to decode encoded email headers"""
    
    decoded_parts = decode_header(header)
    decoded_string = ''
    for part, encoding in decoded_parts: 
        if isinstance(part, bytes): 
            # Decode bytes to string using the specified encoding 
            decoded_string += part.decode(encoding or 'utf-8') 
        else: 
            # Already a string 
            decoded_string += part 
    return decoded_string


class GmailService:
    def __init__(self,
                 creds_file_path: str,
                 token_path: str,
                 scopes: list[str] = ['https://www.googleapis.com/auth/gmail.modify']):
        logger.info(f"Initializing GmailService with creds file: {creds_file_path}")
        self.creds_file_path = creds_file_path
        self.token_path = token_path
        self.scopes = scopes
        self.token = self._get_token()
        logger.info("Token retrieved successfully")
        self.service = self._get_service()
        logger.info("Gmail service initialized")
        self.user_email = self._get_user_email()
        logger.info(f"User email retrieved: {self.user_email}")

    def _get_token(self) -> Credentials:
        """Get or refresh Google API token"""

        token = None
    
        if os.path.exists(self.token_path):
            logger.info('Loading token from file')
            token = Credentials.from_authorized_user_file(self.token_path, self.scopes)

        if not token or not token.valid:
            if token and token.expired and token.refresh_token:
                logger.info('Refreshing token')
                token.refresh(Request())
            else:
                logger.info('Fetching new token')
                flow = InstalledAppFlow.from_client_secrets_file(self.creds_file_path, self.scopes)
                token = flow.run_local_server(port=0)

            with open(self.token_path, 'w') as token_file:
                token_file.write(token.to_json())
                logger.info(f'Token saved to {self.token_path}')

        return token

    def _get_service(self) -> Any:
        """Initialize Gmail API service"""
        try:
            service = build('gmail', 'v1', credentials=self.token)
            return service
        except HttpError as error:
            logger.error(f'An error occurred building Gmail service: {error}')
            raise ValueError(f'An error occurred: {error}')
    
    def _get_user_email(self) -> str:
        """Get user email address"""
        profile = self.service.users().getProfile(userId='me').execute()
        user_email = profile.get('emailAddress', '')
        return user_email
    
    async def send_email(self, recipient_id: str, subject: str, message: str,) -> dict:
        """Creates and sends an email message"""
        try:
            message_obj = EmailMessage()
            message_obj.set_content(message)
            
            message_obj['To'] = recipient_id
            message_obj['From'] = self.user_email
            message_obj['Subject'] = subject

            encoded_message = base64.urlsafe_b64encode(message_obj.as_bytes()).decode()
            create_message = {'raw': encoded_message}
            
            send_message = await asyncio.to_thread(
                self.service.users().messages().send(userId="me", body=create_message).execute
            )
            logger.info(f"Message sent: {send_message['id']}")
            return {"status": "success", "message_id": send_message["id"]}
        except HttpError as error:
            return {"status": "error", "error_message": str(error)}

    async def open_email(self, email_id: str) -> str:
        """Opens email in browser given ID."""
        try:
            url = f"https://mail.google.com/#all/{email_id}"
            webbrowser.open(url, new=0, autoraise=True)
            return "Email opened in browser successfully."
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"

    async def get_unread_emails(self, max_results: int = 100) -> list[dict[str, str]]| str:
        """
        Retrieves unread messages from mailbox.
        Returns a list of messages with id, threadId, subject, from, date and snippet."""
        try:
            user_id = 'me'
            query = 'is:unread'

            response = await asyncio.to_thread(
                self.service.users().messages().list(
                    userId=user_id,
                    q=query,
                    maxResults=max_results
                ).execute
            )

            messages = []
            if 'messages' in response:
                messages.extend(response['messages'])

            while 'nextPageToken' in response and len(messages) < max_results:
                page_token = response['nextPageToken']
                response = await asyncio.to_thread(
                    self.service.users().messages().list(
                        userId=user_id,
                        q=query,
                        pageToken=page_token,
                        maxResults=max_results - len(messages)
                    ).execute
                )
                if 'messages' in response:
                    messages.extend(response['messages'])

            result_messages = []
            for msg in messages:
                msg_data = await asyncio.to_thread(
                    self.service.users().messages().get(
                        userId=user_id,
                        id=msg['id'],
                        format='metadata',
                        metadataHeaders=['Subject', 'From', 'Date']
                    ).execute
                )

                headers = msg_data.get('payload', {}).get('headers', [])

                subject = next((header['value'] for header in headers if header['name'].lower() == 'subject'), 'No Subject')
                sender = next((header['value'] for header in headers if header['name'].lower() == 'from'), 'Unknown Sender')
                date = next((header['value'] for header in headers if header['name'].lower() == 'date'), '')

                result_messages.append({
                    'id': msg['id'],
                    'threadId': msg['threadId'],
                    'subject': decode_mime_header(subject),
                    'from': sender,
                    'date': date,
                    'snippet': msg_data.get('snippet', '')
                })

            return result_messages

        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"

    async def read_email(self, email_id: str) -> dict[str, str]| str:
        """Retrieves email contents including to, from, subject, and contents."""
        try:
            msg = self.service.users().messages().get(userId="me", id=email_id, format='raw').execute()
            email_metadata = {}

            # Decode the base64URL encoded raw content
            raw_data = msg['raw']
            decoded_data = urlsafe_b64decode(raw_data)

            # Parse the RFC 2822 email
            mime_message = message_from_bytes(decoded_data)

            # Extract the email body
            body = None
            if mime_message.is_multipart():
                for part in mime_message.walk():
                    # Extract the text/plain part
                    if part.get_content_type() == "text/plain":
                        body = part.get_payload(decode=True).decode()
                        break
            else:
                # For non-multipart messages
                body = mime_message.get_payload(decode=True).decode()
            email_metadata['content'] = body
            
            # Extract metadata
            email_metadata['subject'] = decode_mime_header(mime_message.get('subject', ''))
            email_metadata['from'] = mime_message.get('from','')
            email_metadata['to'] = mime_message.get('to','')
            email_metadata['date'] = mime_message.get('date','')
            
            logger.info(f"Email read: {email_id}")
            
            # We want to mark email as read once we read it
            await self.mark_email_as_read(email_id)

            return email_metadata
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
        
    async def trash_email(self, email_id: str) -> str:
        """Moves email to trash given ID."""
        try:
            self.service.users().messages().trash(userId="me", id=email_id).execute()
            logger.info(f"Email moved to trash: {email_id}")
            return "Email moved to trash successfully."
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
        
    async def mark_email_as_read(self, email_id: str) -> str:
        """Marks email as read given ID."""
        try:
            self.service.users().messages().modify(userId="me", id=email_id, body={'removeLabelIds': ['UNREAD']}).execute()
            logger.info(f"Email marked as read: {email_id}")
            return "Email marked as read."
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def create_draft(self, recipient_id: str, subject: str, message: str) -> dict:
        """Creates a draft email message"""
        try:
            message_obj = EmailMessage()
            message_obj.set_content(message)
            
            message_obj['To'] = recipient_id
            message_obj['From'] = self.user_email
            message_obj['Subject'] = subject

            encoded_message = base64.urlsafe_b64encode(message_obj.as_bytes()).decode()
            create_message = {'raw': encoded_message}
            
            draft = await asyncio.to_thread(
                self.service.users().drafts().create(userId="me", body={'message': create_message}).execute
            )
            logger.info(f"Draft created: {draft['id']}")
            return {"status": "success", "draft_id": draft["id"]}
        except HttpError as error:
            return {"status": "error", "error_message": str(error)}
    
    async def list_drafts(self) -> list[dict] | str:
        """Lists all draft emails"""
        try:
            results = await asyncio.to_thread(
                self.service.users().drafts().list(userId="me").execute
            )
            drafts = results.get('drafts', [])
            
            draft_list = []
            for draft in drafts:
                draft_id = draft['id']
                # Get the draft details to extract subject and recipient
                draft_data = await asyncio.to_thread(
                    self.service.users().drafts().get(userId="me", id=draft_id).execute
                )
                
                message = draft_data.get('message', {})
                headers = message.get('payload', {}).get('headers', [])
                
                subject = next((header['value'] for header in headers if header['name'].lower() == 'subject'), 'No Subject')
                to = next((header['value'] for header in headers if header['name'].lower() == 'to'), 'No Recipient')
                
                draft_list.append({
                    'id': draft_id,
                    'subject': subject,
                    'to': to
                })
                
            return draft_list
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def list_labels(self) -> list[dict] | str:
        """Lists all labels in the user's mailbox"""
        try:
            results = await asyncio.to_thread(
                self.service.users().labels().list(userId="me").execute
            )
            labels = results.get('labels', [])
            
            label_list = []
            for label in labels:
                label_list.append({
                    'id': label['id'],
                    'name': label['name'],
                    'type': label['type']  # 'system' or 'user'
                })
                
            return label_list
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def create_label(self, name: str) -> dict | str:
        """Creates a new label"""
        try:
            label_object = {
                'name': name,
                'labelListVisibility': 'labelShow',  # Show in label list
                'messageListVisibility': 'show'  # Show in message list
            }
            
            created_label = await asyncio.to_thread(
                self.service.users().labels().create(userId="me", body=label_object).execute
            )
            
            logger.info(f"Label created: {created_label['id']}")
            return {
                'status': 'success',
                'label_id': created_label['id'],
                'name': created_label['name']
            }
        except HttpError as error:
            return {"status": "error", "error_message": str(error)}
    
    async def apply_label(self, email_id: str, label_id: str) -> str:
        """Applies a label to an email"""
        try:
            await asyncio.to_thread(
                self.service.users().messages().modify(
                    userId="me", 
                    id=email_id, 
                    body={'addLabelIds': [label_id]}
                ).execute
            )
            
            logger.info(f"Label {label_id} applied to email {email_id}")
            return f"Label applied successfully to email."
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def remove_label(self, email_id: str, label_id: str) -> str:
        """Removes a label from an email"""
        try:
            await asyncio.to_thread(
                self.service.users().messages().modify(
                    userId="me", 
                    id=email_id, 
                    body={'removeLabelIds': [label_id]}
                ).execute
            )
            
            logger.info(f"Label {label_id} removed from email {email_id}")
            return f"Label removed successfully from email."
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def search_by_label(self, label_id: str) -> list[dict] | str:
        """Searches for emails with a specific label"""
        try:
            query = f"label:{label_id}"
            
            response = await asyncio.to_thread(
                self.service.users().messages().list(userId="me", q=query).execute
            )
            
            messages = []
            if 'messages' in response:
                messages.extend(response['messages'])

            while 'nextPageToken' in response:
                page_token = response['nextPageToken']
                response = await asyncio.to_thread(
                    self.service.users().messages().list(
                        userId="me", 
                        q=query,
                        pageToken=page_token
                    ).execute
                )
                messages.extend(response['messages'])
                
            return messages
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def list_filters(self) -> list[dict] | str:
        """Lists all filters in the user's mailbox"""
        try:
            results = await asyncio.to_thread(
                self.service.users().settings().filters().list(userId="me").execute
            )
            filters = results.get('filter', [])
            return filters
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def get_filter(self, filter_id: str) -> dict | str:
        """Gets a specific filter by ID"""
        try:
            filter_data = await asyncio.to_thread(
                self.service.users().settings().filters().get(userId="me", id=filter_id).execute
            )
            return filter_data
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def create_filter(self, 
                           from_email: str = None,
                           to_email: str = None,
                           subject: str = None,
                           query: str = None,
                           has_attachment: bool = None,
                           exclude_chats: bool = None,
                           size_comparison: str = None,
                           size: int = None,
                           add_label_ids: list[str] = None,
                           remove_label_ids: list[str] = None,
                           forward_to: str = None) -> dict | str:
        """Creates a new email filter
        
        Args:
            from_email: Email from a specific sender
            to_email: Email to a specific recipient
            subject: Email with a specific subject
            query: Email matching a custom query
            has_attachment: Email has an attachment
            exclude_chats: Exclude chats from filter
            size_comparison: 'larger' or 'smaller'
            size: Size in bytes for comparison
            add_label_ids: Labels to add to matching emails
            remove_label_ids: Labels to remove from matching emails
            forward_to: Email address to forward matching emails to
        """
        try:
            # Build the filter criteria
            criteria = {}
            if from_email:
                criteria['from'] = from_email
            if to_email:
                criteria['to'] = to_email
            if subject:
                criteria['subject'] = subject
            if query:
                criteria['query'] = query
            if has_attachment is not None:
                criteria['hasAttachment'] = has_attachment
            if exclude_chats is not None:
                criteria['excludeChats'] = exclude_chats
            if size_comparison and size:
                if size_comparison.lower() == 'larger':
                    criteria['sizeComparison'] = 'larger'
                    criteria['size'] = size
                elif size_comparison.lower() == 'smaller':
                    criteria['sizeComparison'] = 'smaller'
                    criteria['size'] = size
            
            # Build the filter actions
            action = {}
            if add_label_ids:
                action['addLabelIds'] = add_label_ids
            if remove_label_ids:
                action['removeLabelIds'] = remove_label_ids
            if forward_to:
                action['forward'] = forward_to
            
            # Create the filter
            filter_object = {
                'criteria': criteria,
                'action': action
            }
            
            created_filter = await asyncio.to_thread(
                self.service.users().settings().filters().create(
                    userId="me", 
                    body=filter_object
                ).execute
            )
            
            logger.info(f"Filter created: {created_filter['id']}")
            return {
                'status': 'success',
                'filter_id': created_filter['id'],
                'filter': created_filter
            }
        except HttpError as error:
            return {"status": "error", "error_message": str(error)}
    
    async def delete_filter(self, filter_id: str) -> str:
        """Deletes a filter by ID"""
        try:
            await asyncio.to_thread(
                self.service.users().settings().filters().delete(
                    userId="me", 
                    id=filter_id
                ).execute
            )
            
            logger.info(f"Filter deleted: {filter_id}")
            return f"Filter deleted successfully."
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def search_emails(self, query: str, max_results: int = 50) -> list[dict] | str:
        """
        Searches for emails using Gmail's search syntax.
        
        Args:
            query: Gmail search query (e.g., 'from:example@gmail.com', 'subject:hello', etc.)
            max_results: Maximum number of results to return (default: 50)
            
        Returns:
            List of message objects or error message
        """
        try:
            user_id = 'me'
            
            response = await asyncio.to_thread(
                self.service.users().messages().list(
                    userId=user_id,
                    q=query,
                    maxResults=max_results
                ).execute
            )
            
            messages = []
            if 'messages' in response:
                messages.extend(response['messages'])

            # Get additional pages if available and needed
            while 'nextPageToken' in response and len(messages) < max_results:
                page_token = response['nextPageToken']
                response = await asyncio.to_thread(
                    self.service.users().messages().list(
                        userId=user_id, 
                        q=query,
                        pageToken=page_token,
                        maxResults=max_results - len(messages)
                    ).execute
                )
                if 'messages' in response:
                    messages.extend(response['messages'])
            
            # Get basic metadata for each message
            result_messages = []
            for msg in messages:
                msg_data = await asyncio.to_thread(
                    self.service.users().messages().get(
                        userId=user_id,
                        id=msg['id'],
                        format='metadata',
                        metadataHeaders=['Subject', 'From', 'Date']
                    ).execute
                )
                
                headers = msg_data.get('payload', {}).get('headers', [])
                
                subject = next((header['value'] for header in headers if header['name'].lower() == 'subject'), 'No Subject')
                sender = next((header['value'] for header in headers if header['name'].lower() == 'from'), 'Unknown Sender')
                date = next((header['value'] for header in headers if header['name'].lower() == 'date'), '')
                
                result_messages.append({
                    'id': msg['id'],
                    'threadId': msg['threadId'],
                    'subject': subject,
                    'from': sender,
                    'date': date,
                    'snippet': msg_data.get('snippet', '')
                })
                
            return result_messages
            
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def create_folder(self, name: str) -> dict | str:
        """
        Creates a new folder (implemented as a label with special handling).
        
        Args:
            name: Name of the folder to create
            
        Returns:
            Dictionary with status and folder information or error message
        """
        try:
            # In Gmail, folders are just labels with special visibility settings
            label_object = {
                'name': name,
                'labelListVisibility': 'labelShow',
                'messageListVisibility': 'show',
                'type': 'user'  # Ensure it's a user label
            }
            
            created_label = await asyncio.to_thread(
                self.service.users().labels().create(userId="me", body=label_object).execute
            )
            
            logger.info(f"Folder created: {created_label['id']}")
            return {
                'status': 'success',
                'folder_id': created_label['id'],
                'name': created_label['name']
            }
        except HttpError as error:
            return {"status": "error", "error_message": str(error)}
    
    async def move_to_folder(self, email_id: str, folder_id: str) -> str:
        """
        Moves an email to a folder by:
        1. Applying the folder label
        2. Removing the INBOX label (to remove from inbox)
        
        Args:
            email_id: ID of the email to move
            folder_id: ID of the folder (label) to move to
            
        Returns:
            Success or error message
        """
        try:
            # First, apply the folder label
            await asyncio.to_thread(
                self.service.users().messages().modify(
                    userId="me", 
                    id=email_id, 
                    body={'addLabelIds': [folder_id], 'removeLabelIds': ['INBOX']}
                ).execute
            )
            
            logger.info(f"Email {email_id} moved to folder {folder_id}")
            return f"Email moved to folder successfully."
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def list_folders(self) -> list[dict] | str:
        """
        Lists all user-created labels (folders)
        
        Returns:
            List of folder information or error message
        """
        try:
            results = await asyncio.to_thread(
                self.service.users().labels().list(userId="me").execute
            )
            labels = results.get('labels', [])
            
            # Filter to only include user-created labels (folders)
            folders = [
                {
                    'id': label['id'],
                    'name': label['name']
                }
                for label in labels
                if label['type'] == 'user'
            ]
                
            return folders
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def rename_label(self, label_id: str, new_name: str) -> dict | str:
        """
        Renames an existing label
        
        Args:
            label_id: ID of the label to rename
            new_name: New name for the label
            
        Returns:
            Dictionary with status and updated label information or error message
        """
        try:
            # First, get the current label to preserve its settings
            label = await asyncio.to_thread(
                self.service.users().labels().get(userId="me", id=label_id).execute
            )
            
            # Update only the name field
            label['name'] = new_name
            
            # Update the label
            updated_label = await asyncio.to_thread(
                self.service.users().labels().update(
                    userId="me", 
                    id=label_id, 
                    body=label
                ).execute
            )
            
            logger.info(f"Label renamed: {label_id} to {new_name}")
            return {
                'status': 'success',
                'label_id': updated_label['id'],
                'name': updated_label['name']
            }
        except HttpError as error:
            return {"status": "error", "error_message": str(error)}
    
    async def delete_label(self, label_id: str) -> str:
        """
        Deletes a label
        
        Args:
            label_id: ID of the label to delete
            
        Returns:
            Success or error message
        """
        try:
            await asyncio.to_thread(
                self.service.users().labels().delete(
                    userId="me", 
                    id=label_id
                ).execute
            )
            
            logger.info(f"Label deleted: {label_id}")
            return f"Label deleted successfully."
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def archive_email(self, email_id: str) -> str:
        """
        Archives an email by removing the INBOX label
        
        Args:
            email_id: ID of the email to archive
            
        Returns:
            Success or error message
        """
        try:
            await asyncio.to_thread(
                self.service.users().messages().modify(
                    userId="me", 
                    id=email_id, 
                    body={'removeLabelIds': ['INBOX']}
                ).execute
            )
            
            logger.info(f"Email archived: {email_id}")
            return f"Email archived successfully."
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
    
    async def batch_archive(self, query: str, max_emails: int = 100) -> dict:
        """
        Archives multiple emails matching a search query
        
        Args:
            query: Gmail search query to find emails to archive
            max_emails: Maximum number of emails to archive in one batch
            
        Returns:
            Dictionary with status and count of archived emails
        """
        try:
            # First, search for emails matching the query
            user_id = 'me'
            
            response = await asyncio.to_thread(
                self.service.users().messages().list(
                    userId=user_id,
                    q=query,
                    maxResults=max_emails
                ).execute
            )
            
            messages = []
            if 'messages' in response:
                messages.extend(response['messages'])
            
            if not messages:
                return {
                    'status': 'success',
                    'archived_count': 0,
                    'message': 'No emails found matching the query.'
                }
            
            # Archive each email in the batch
            archived_count = 0
            for msg in messages:
                try:
                    await asyncio.to_thread(
                        self.service.users().messages().modify(
                            userId="me", 
                            id=msg['id'], 
                            body={'removeLabelIds': ['INBOX']}
                        ).execute
                    )
                    archived_count += 1
                except Exception as e:
                    logger.error(f"Error archiving email {msg['id']}: {str(e)}")
            
            logger.info(f"Batch archived {archived_count} emails")
            return {
                'status': 'success',
                'archived_count': archived_count,
                'total_found': len(messages),
                'message': f"Successfully archived {archived_count} out of {len(messages)} emails."
            }
        except HttpError as error:
            return {
                'status': 'error',
                'error_message': str(error)
            }
    
    async def list_archived(self, max_results: int = 50) -> list[dict] | str:
        """
        Lists archived emails (emails not in inbox)
        
        Args:
            max_results: Maximum number of results to return
            
        Returns:
            List of archived email objects or error message
        """
        try:
            # Search for emails that are in "All Mail" but not in "Inbox"
            query = "-in:inbox"
            
            # Use the existing search_emails method
            return await self.search_emails(query, max_results)
        except Exception as error:
            return f"An error occurred: {str(error)}"
    
    async def restore_to_inbox(self, email_id: str) -> str:
        """
        Restores an archived email to the inbox
        
        Args:
            email_id: ID of the email to restore
            
        Returns:
            Success or error message
        """
        try:
            await asyncio.to_thread(
                self.service.users().messages().modify(
                    userId="me", 
                    id=email_id, 
                    body={'addLabelIds': ['INBOX']}
                ).execute
            )
            
            logger.info(f"Email restored to inbox: {email_id}")
            return f"Email restored to inbox successfully."
        except HttpError as error:
            return f"An HttpError occurred: {str(error)}"
  
async def main(creds_file_path: str,
               token_path: str):
    
    gmail_service = GmailService(creds_file_path, token_path)

    async def list_prompts(ctx, params) -> types.ListPromptsResult:
        return types.ListPromptsResult(prompts=list(PROMPTS.values()))

    async def get_prompt(ctx, params: types.GetPromptRequestParams) -> types.GetPromptResult:
        arguments = params.arguments or {}
        name = params.name
        if name not in PROMPTS:
            raise ValueError(f"Prompt not found: {name}")

        if name == "manage-email":
            return types.GetPromptResult(
                messages=[
                    types.PromptMessage(
                        role="user",
                        content=types.TextContent(
                            type="text",
                            text=EMAIL_ADMIN_PROMPTS,
                        )
                    )
                ]
            )

        if name == "draft-email":
            content = arguments.get("content", "")
            recipient = arguments.get("recipient", "")
            recipient_email = arguments.get("recipient_email", "")
            
            # First message asks the LLM to create the draft
            return types.GetPromptResult(
                messages=[
                    types.PromptMessage(
                        role="user",
                        content=types.TextContent(
                            type="text",
                            text=f"""Please draft an email about {content} for {recipient} ({recipient_email}).
                            Include a subject line starting with 'Subject:' on the first line.
                            Do not send the email yet, just draft it and ask the user for their thoughts."""
                        )
                    )
                ]
            )
        
        elif name == "edit-draft":
            changes = arguments.get("changes", "")
            current_draft = arguments.get("current_draft", "")
            
            # Edit existing draft based on requested changes
            return types.GetPromptResult(
                messages=[
                    types.PromptMessage(
                        role="user",
                        content=types.TextContent(
                            type="text",
                            text=f"""Please revise the current email draft:
                            {current_draft}
                            
                            Requested changes:
                            {changes}
                            
                            Please provide the updated draft."""
                        )
                    )
                ]
            )
        
        elif name == "manage-labels":
            action = arguments.get("action", "")
            
            # Guide the LLM on how to manage labels
            return types.GetPromptResult(
                messages=[
                    types.PromptMessage(
                        role="user",
                        content=types.TextContent(
                            type="text",
                            text=f"""I need help with managing my email labels. Specifically, I want to {action}.

Here are the tools you can use for label management:
- list-labels: Lists all existing labels in my Gmail account
- create-label: Creates a new label with a specified name
- apply-label: Applies a label to a specific email
- remove-label: Removes a label from a specific email
- rename-label: Renames an existing label
- delete-label: Permanently deletes a label
- search-by-label: Finds all emails with a specific label

Please help me {action} by using the appropriate tools. If you need to list labels first to get label IDs, please do so."""
                        )
                    )
                ]
            )

        elif name == "manage-filters":
            action = arguments.get("action", "")
            
            # Guide the LLM on how to manage filters
            return types.GetPromptResult(
                messages=[
                    types.PromptMessage(
                        role="user",
                        content=types.TextContent(
                            type="text",
                            text=f"""I need help with managing my email filters. Specifically, I want to {action}.

Here are the tools you can use for filter management:
- list-filters: Lists all existing filters in my Gmail account
- get-filter: Gets details of a specific filter
- create-filter: Creates a new filter
- delete-filter: Deletes a specific filter

Please help me {action} by using the appropriate tools. If you need to list filters first to get filter IDs, please do so."""
                        )
                    )
                ]
            )

        elif name == "search-emails":
            query = arguments.get("query", "")
            
            # Guide the LLM on how to search emails
            return types.GetPromptResult(
                messages=[
                    types.PromptMessage(
                        role="user",
                        content=types.TextContent(
                            type="text",
                            text=f"""I need to search through my emails for: {query}

Here are the tools you can use for searching emails:
- search-emails: Searches all emails using Gmail's search syntax
- get-unread-emails: Gets only unread emails from the inbox

Please help me find emails matching my search criteria. You can use Gmail's search syntax for advanced searches:
- from:sender - Emails from a specific sender
- to:recipient - Emails to a specific recipient
- subject:text - Emails with specific text in the subject
- has:attachment - Emails with attachments
- after:YYYY/MM/DD - Emails after a specific date
- before:YYYY/MM/DD - Emails before a specific date
- is:important - Important emails
- label:name - Emails with a specific label

Please search for emails matching: {query}"""
                        )
                    )
                ]
            )
            
        elif name == "manage-folders":
            action = arguments.get("action", "")
            
            # Guide the LLM on how to manage folders
            return types.GetPromptResult(
                messages=[
                    types.PromptMessage(
                        role="user",
                        content=types.TextContent(
                            type="text",
                            text=f"""I need help with managing my email folders. Specifically, I want to {action}.

Here are the tools you can use for folder management:
- list-folders: Lists all existing folders in my Gmail account
- create-folder: Creates a new folder with a specified name
- move-to-folder: Moves an email to a specific folder (removes it from inbox)

Please help me {action} by using the appropriate tools. If you need to list folders first to get folder IDs, please do so.

Note: In Gmail, folders are implemented as labels with special handling. When you move an email to a folder, it applies the folder's label and removes the email from the inbox."""
                        )
                    )
                ]
            )
            
        elif name == "manage-archive":
            action = arguments.get("action", "")
            
            # Guide the LLM on how to manage archives
            return types.GetPromptResult(
                messages=[
                    types.PromptMessage(
                        role="user",
                        content=types.TextContent(
                            type="text",
                            text=f"""I need help with managing my email archives. Specifically, I want to {action}.

Here are the tools you can use for archive management:
- archive-email: Archives a single email (removes from inbox without deleting)
- batch-archive: Archives multiple emails matching a search query
- list-archived: Lists emails that have been archived
- restore-to-inbox: Restores an archived email back to the inbox

Please help me {action} by using the appropriate tools.

For batch archiving, you can use Gmail's search syntax to find emails to archive:
- from:sender - Emails from a specific sender
- older_than:30d - Emails older than 30 days
- has:attachment - Emails with attachments
- subject:text - Emails with specific text in the subject
- before:YYYY/MM/DD - Emails before a specific date

Note: Archiving in Gmail means removing the email from your inbox while keeping it accessible in "All Mail". It's a great way to declutter your inbox without losing any emails."""
                        )
                    )
                ]
            )

        raise ValueError("Prompt implementation not found")

    async def handle_list_tools(ctx, params) -> types.ListToolsResult:
        tools_list = [
            types.Tool(
                name="send-email",
                description="""Sends email to recipient. 
                Do not use if user only asked to draft email. 
                Drafts must be approved before sending.""",
                input_schema={
                    "type": "object",
                    "properties": {
                        "recipient_id": {
                            "type": "string",
                            "description": "Recipient email address",
                        },
                        "subject": {
                            "type": "string",
                            "description": "Email subject",
                        },
                        "message": {
                            "type": "string",
                            "description": "Email content text",
                        },
                    },
                    "required": ["recipient_id", "subject", "message"],
                },
            ),
            types.Tool(
                name="trash-email",
                description="""Moves email to trash. 
                Confirm before moving email to trash.""",
                input_schema={
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "Email ID",
                        },
                    },
                    "required": ["email_id"],
                },
            ),
            types.Tool(
                name="get-unread-emails",
                description="Retrieve unread emails",
                input_schema={
                    "type": "object",
                    "properties": {},
                    "required": []
                },
            ),
            types.Tool(
                name="read-email",
                description="Retrieves given email content",
                input_schema={
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "Email ID",
                        },
                    },
                    "required": ["email_id"],
                },
            ),
            types.Tool(
                name="mark-email-as-read",
                description="Marks given email as read",
                input_schema={
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "Email ID",
                        },
                    },
                    "required": ["email_id"],
                },
            ),
            types.Tool(
                name="open-email",
                description="Open email in browser",
                input_schema={
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "Email ID",
                        },
                    },
                    "required": ["email_id"],
                },
            ),
            types.Tool(
                name="create-draft",
                description="Creates a draft email without sending it",
                input_schema={
                    "type": "object",
                    "properties": {
                        "recipient_id": {
                            "type": "string",
                            "description": "Recipient email address",
                        },
                        "subject": {
                            "type": "string",
                            "description": "Email subject",
                        },
                        "message": {
                            "type": "string",
                            "description": "Email content text",
                        },
                    },
                    "required": ["recipient_id", "subject", "message"],
                },
            ),
            types.Tool(
                name="list-drafts",
                description="Lists all draft emails",
                input_schema={
                    "type": "object",
                    "properties": {},
                    "required": []
                },
            ),
            types.Tool(
                name="list-labels",
                description="Lists all labels in the user's mailbox",
                input_schema={
                    "type": "object",
                    "properties": {},
                    "required": []
                },
            ),
            types.Tool(
                name="create-label",
                description="Creates a new label",
                input_schema={
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Label name",
                        },
                    },
                    "required": ["name"],
                },
            ),
            types.Tool(
                name="apply-label",
                description="Applies a label to an email",
                input_schema={
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "Email ID",
                        },
                        "label_id": {
                            "type": "string",
                            "description": "Label ID",
                        },
                    },
                    "required": ["email_id", "label_id"],
                },
            ),
            types.Tool(
                name="remove-label",
                description="Removes a label from an email",
                input_schema={
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "Email ID",
                        },
                        "label_id": {
                            "type": "string",
                            "description": "Label ID",
                        },
                    },
                    "required": ["email_id", "label_id"],
                },
            ),
            types.Tool(
                name="rename-label",
                description="Renames an existing label",
                input_schema={
                    "type": "object",
                    "properties": {
                        "label_id": {
                            "type": "string",
                            "description": "Label ID to rename",
                        },
                        "new_name": {
                            "type": "string",
                            "description": "New name for the label",
                        },
                    },
                    "required": ["label_id", "new_name"],
                },
            ),
            types.Tool(
                name="delete-label",
                description="Permanently deletes a label",
                input_schema={
                    "type": "object",
                    "properties": {
                        "label_id": {
                            "type": "string",
                            "description": "Label ID to delete",
                        },
                    },
                    "required": ["label_id"],
                },
            ),
            types.Tool(
                name="search-by-label",
                description="Searches for emails with a specific label",
                input_schema={
                    "type": "object",
                    "properties": {
                        "label_id": {
                            "type": "string",
                            "description": "Label ID",
                        },
                    },
                    "required": ["label_id"],
                },
            ),
            types.Tool(
                name="list-filters",
                description="Lists all email filters in the user's mailbox",
                input_schema={
                    "type": "object",
                    "properties": {},
                    "required": []
                },
            ),
            types.Tool(
                name="get-filter",
                description="Gets details of a specific filter",
                input_schema={
                    "type": "object",
                    "properties": {
                        "filter_id": {
                            "type": "string",
                            "description": "Filter ID",
                        },
                    },
                    "required": ["filter_id"],
                },
            ),
            types.Tool(
                name="create-filter",
                description="Creates a new email filter",
                input_schema={
                    "type": "object",
                    "properties": {
                        "from_email": {
                            "type": "string",
                            "description": "Filter emails from this sender",
                        },
                        "to_email": {
                            "type": "string",
                            "description": "Filter emails to this recipient",
                        },
                        "subject": {
                            "type": "string",
                            "description": "Filter emails with this subject",
                        },
                        "query": {
                            "type": "string",
                            "description": "Filter emails matching this query",
                        },
                        "has_attachment": {
                            "type": "boolean",
                            "description": "Filter emails with attachments",
                        },
                        "exclude_chats": {
                            "type": "boolean",
                            "description": "Exclude chats from filter",
                        },
                        "size_comparison": {
                            "type": "string",
                            "description": "Size comparison ('larger' or 'smaller')",
                        },
                        "size": {
                            "type": "integer",
                            "description": "Size in bytes for comparison",
                        },
                        "add_label_ids": {
                            "type": "array",
                            "items": {
                                "type": "string"
                            },
                            "description": "Labels to add to matching emails",
                        },
                        "remove_label_ids": {
                            "type": "array",
                            "items": {
                                "type": "string"
                            },
                            "description": "Labels to remove from matching emails",
                        },
                        "forward_to": {
                            "type": "string",
                            "description": "Email address to forward matching emails to",
                        },
                    },
                },
            ),
            types.Tool(
                name="delete-filter",
                description="Deletes a specific filter",
                input_schema={
                    "type": "object",
                    "properties": {
                        "filter_id": {
                            "type": "string",
                            "description": "Filter ID",
                        },
                    },
                    "required": ["filter_id"],
                },
            ),
            types.Tool(
                name="search-emails",
                description="Searches for emails using Gmail's search syntax",
                input_schema={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Gmail search query",
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "Maximum number of results to return",
                        },
                    },
                    "required": ["query"],
                },
            ),
            types.Tool(
                name="create-folder",
                description="Creates a new folder",
                input_schema={
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Folder name",
                        },
                    },
                    "required": ["name"],
                },
            ),
            types.Tool(
                name="move-to-folder",
                description="Moves an email to a folder",
                input_schema={
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "Email ID",
                        },
                        "folder_id": {
                            "type": "string",
                            "description": "Folder ID",
                        },
                    },
                    "required": ["email_id", "folder_id"],
                },
            ),
            types.Tool(
                name="list-folders",
                description="Lists all user-created folders",
                input_schema={
                    "type": "object",
                    "properties": {},
                    "required": []
                },
            ),
            types.Tool(
                name="archive-email",
                description="Archives an email (removes from inbox without deleting)",
                input_schema={
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "Email ID to archive",
                        },
                    },
                    "required": ["email_id"],
                },
            ),
            types.Tool(
                name="batch-archive",
                description="Archives multiple emails matching a search query",
                input_schema={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Gmail search query to find emails to archive",
                        },
                        "max_emails": {
                            "type": "integer",
                            "description": "Maximum number of emails to archive (default: 100)",
                        },
                    },
                    "required": ["query"],
                },
            ),
            types.Tool(
                name="list-archived",
                description="Lists archived emails (not in inbox)",
                input_schema={
                    "type": "object",
                    "properties": {
                        "max_results": {
                            "type": "integer",
                            "description": "Maximum number of results to return",
                        },
                    },
                    "required": [],
                },
            ),
            types.Tool(
                name="restore-to-inbox",
                description="Restores an archived email back to the inbox",
                input_schema={
                    "type": "object",
                    "properties": {
                        "email_id": {
                            "type": "string",
                            "description": "Email ID to restore to inbox",
                        },
                    },
                    "required": ["email_id"],
                },
            ),
        ]
        return types.ListToolsResult(tools=tools_list)


    async def handle_call_tool(ctx, params: types.CallToolRequestParams) -> types.CallToolResult:
        name = params.name
        arguments = params.arguments or {}

        if name == "send-email":
            recipient = arguments.get("recipient_id")
            if not recipient:
                raise ValueError("Missing recipient parameter")
            subject = arguments.get("subject")
            if not subject:
                raise ValueError("Missing subject parameter")
            message = arguments.get("message")
            if not message:
                raise ValueError("Missing message parameter")
                
            # Extract subject and message content
            email_lines = message.split('\n')
            if email_lines[0].startswith('Subject:'):
                subject = email_lines[0][8:].strip()
                message_content = '\n'.join(email_lines[1:]).strip()
            else:
                message_content = message
                
            send_response = await gmail_service.send_email(recipient, subject, message_content)
            
            if send_response["status"] == "success":
                response_text = f"Email sent successfully. Message ID: {send_response['message_id']}"
            else:
                response_text = f"Failed to send email: {send_response['error_message']}"
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=response_text )]
            )

        if name == "get-unread-emails":
                
            unread_emails = await gmail_service.get_unread_emails()
            data = unread_emails
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(data))],
                structured_content=data if isinstance(data, dict) else ({"data": data, "count": len(data)} if isinstance(data, list) else None),
            )
        
        if name == "read-email":
            email_id = arguments.get("email_id")
            if not email_id:
                raise ValueError("Missing email ID parameter")
                
            retrieved_email = await gmail_service.read_email(email_id)
            data = retrieved_email
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(data))],
                structured_content=data if isinstance(data, dict) else ({"data": data, "count": len(data)} if isinstance(data, list) else None),
            )
        if name == "open-email":
            email_id = arguments.get("email_id")
            if not email_id:
                raise ValueError("Missing email ID parameter")
                
            msg = await gmail_service.open_email(email_id)
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(msg) )]
            )
        if name == "trash-email":
            email_id = arguments.get("email_id")
            if not email_id:
                raise ValueError("Missing email ID parameter")
                
            msg = await gmail_service.trash_email(email_id)
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(msg) )]
            )
        if name == "mark-email-as-read":
            email_id = arguments.get("email_id")
            if not email_id:
                raise ValueError("Missing email ID parameter")
                
            msg = await gmail_service.mark_email_as_read(email_id)
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(msg) )]
            )
        elif name == "create-draft":
            recipient_id = arguments.get("recipient_id")
            subject = arguments.get("subject")
            message = arguments.get("message")
            if not recipient_id or not subject or not message:
                raise ValueError("Missing required parameters for creating a draft")
            draft_response = await gmail_service.create_draft(recipient_id, subject, message)
            if draft_response["status"] == "success":
                response_text = f"Draft created successfully. Draft ID: {draft_response['draft_id']}"
            else:
                response_text = f"Failed to create draft: {draft_response['error_message']}"
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=response_text )]
            )
        elif name == "list-drafts":
            drafts = await gmail_service.list_drafts()
            data = drafts
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(data))],
                structured_content=data if isinstance(data, dict) else ({"data": data, "count": len(data)} if isinstance(data, list) else None),
            )
        elif name == "list-labels":
            labels = await gmail_service.list_labels()
            data = labels
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(data))],
                structured_content=data if isinstance(data, dict) else ({"data": data, "count": len(data)} if isinstance(data, list) else None),
            )
        elif name == "create-label":
            name = arguments.get("name")
            if not name:
                raise ValueError("Missing required parameter for creating a label")
            label_response = await gmail_service.create_label(name)
            if label_response["status"] == "success":
                response_text = f"Label created successfully. Label ID: {label_response['label_id']}, Name: {label_response['name']}"
            else:
                response_text = f"Failed to create label: {label_response['error_message']}"
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=response_text )]
            )
        elif name == "apply-label":
            email_id = arguments.get("email_id")
            label_id = arguments.get("label_id")
            if not email_id or not label_id:
                raise ValueError("Missing required parameters for applying a label")
            msg = await gmail_service.apply_label(email_id, label_id)
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(msg) )]
            )
        elif name == "remove-label":
            email_id = arguments.get("email_id")
            label_id = arguments.get("label_id")
            if not email_id or not label_id:
                raise ValueError("Missing required parameters for removing a label")
            msg = await gmail_service.remove_label(email_id, label_id)
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(msg) )]
            )
        elif name == "search-by-label":
            label_id = arguments.get("label_id")
            if not label_id:
                raise ValueError("Missing required parameter for searching by label")
            messages = await gmail_service.search_by_label(label_id)
            data = messages
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(data))],
                structured_content=data if isinstance(data, dict) else ({"data": data, "count": len(data)} if isinstance(data, list) else None),
            )
        elif name == "list-filters":
            filters = await gmail_service.list_filters()
            data = filters
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(data))],
                structured_content=data if isinstance(data, dict) else ({"data": data, "count": len(data)} if isinstance(data, list) else None),
            )
        elif name == "get-filter":
            filter_id = arguments.get("filter_id")
            if not filter_id:
                raise ValueError("Missing required parameter for getting a filter")
            filter_data = await gmail_service.get_filter(filter_id)
            data = filter_data
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(data))],
                structured_content=data if isinstance(data, dict) else ({"data": data, "count": len(data)} if isinstance(data, list) else None),
            )
        elif name == "create-filter":
            from_email = arguments.get("from_email")
            to_email = arguments.get("to_email")
            subject = arguments.get("subject")
            query = arguments.get("query")
            has_attachment = arguments.get("has_attachment")
            exclude_chats = arguments.get("exclude_chats")
            size_comparison = arguments.get("size_comparison")
            size = arguments.get("size")
            add_label_ids = arguments.get("add_label_ids")
            remove_label_ids = arguments.get("remove_label_ids")
            forward_to = arguments.get("forward_to")
            if not from_email and not to_email and not subject and not query and has_attachment is None and exclude_chats is None and size_comparison is None and size is None and add_label_ids is None and remove_label_ids is None and forward_to is None:
                raise ValueError("Missing required parameters for creating a filter")
            filter_response = await gmail_service.create_filter(from_email, to_email, subject, query, has_attachment, exclude_chats, size_comparison, size, add_label_ids, remove_label_ids, forward_to)
            if filter_response["status"] == "success":
                response_text = f"Filter created successfully. Filter ID: {filter_response['filter_id']}, Filter: {filter_response['filter']}"
            else:
                response_text = f"Failed to create filter: {filter_response['error_message']}"
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=response_text )]
            )
        elif name == "delete-filter":
            filter_id = arguments.get("filter_id")
            if not filter_id:
                raise ValueError("Missing required parameter for deleting a filter")
            msg = await gmail_service.delete_filter(filter_id)
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(msg) )]
            )
        elif name == "search-emails":
            query = arguments.get("query")
            max_results = arguments.get("max_results", 50)
            if not query:
                raise ValueError("Missing required parameter for searching emails")
            messages = await gmail_service.search_emails(query, max_results)
            data = messages
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(data))],
                structured_content=data if isinstance(data, dict) else ({"data": data, "count": len(data)} if isinstance(data, list) else None),
            )
        elif name == "create-folder":
            name = arguments.get("name")
            if not name:
                raise ValueError("Missing required parameter for creating a folder")
            folder_response = await gmail_service.create_folder(name)
            if folder_response["status"] == "success":
                response_text = f"Folder created successfully. Folder ID: {folder_response['folder_id']}, Name: {folder_response['name']}"
            else:
                response_text = f"Failed to create folder: {folder_response['error_message']}"
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=response_text )]
            )
        elif name == "move-to-folder":
            email_id = arguments.get("email_id")
            folder_id = arguments.get("folder_id")
            if not email_id or not folder_id:
                raise ValueError("Missing required parameters for moving an email to a folder")
            msg = await gmail_service.move_to_folder(email_id, folder_id)
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(msg) )]
            )
        elif name == "list-folders":
            folders = await gmail_service.list_folders()
            data = folders
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(data))],
                structured_content=data if isinstance(data, dict) else ({"data": data, "count": len(data)} if isinstance(data, list) else None),
            )
        elif name == "rename-label":
            label_id = arguments.get("label_id")
            new_name = arguments.get("new_name")
            if not label_id or not new_name:
                raise ValueError("Missing required parameters for renaming a label")
            rename_response = await gmail_service.rename_label(label_id, new_name)
            if rename_response["status"] == "success":
                response_text = f"Label renamed successfully. Label ID: {rename_response['label_id']}, New name: {rename_response['name']}"
            else:
                response_text = f"Failed to rename label: {rename_response['error_message']}"
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=response_text )]
            )
        elif name == "delete-label":
            label_id = arguments.get("label_id")
            if not label_id:
                raise ValueError("Missing required parameter for deleting a label")
            msg = await gmail_service.delete_label(label_id)
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(msg) )]
            )
        elif name == "archive-email":
            email_id = arguments.get("email_id")
            if not email_id:
                raise ValueError("Missing required parameter for archiving an email")
            msg = await gmail_service.archive_email(email_id)
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(msg) )]
            )
        elif name == "batch-archive":
            query = arguments.get("query")
            max_emails = arguments.get("max_emails", 100)
            if not query:
                raise ValueError("Missing required parameter for batch archiving")
            archive_response = await gmail_service.batch_archive(query, max_emails)
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(archive_response) )]
            )
        elif name == "list-archived":
            max_results = arguments.get("max_results", 50)
            archived_emails = await gmail_service.list_archived(max_results)
            data = archived_emails
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(data))],
                structured_content=data if isinstance(data, dict) else ({"data": data, "count": len(data)} if isinstance(data, list) else None),
            )
        elif name == "restore-to-inbox":
            email_id = arguments.get("email_id")
            if not email_id:
                raise ValueError("Missing required parameter for restoring an email to inbox")
            msg = await gmail_service.restore_to_inbox(email_id)
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(msg) )]
            )
        else:
            logger.error(f"Unknown tool: {name}")
            raise ValueError(f"Unknown tool: {name}")

    server = Server(
        "gmail",
        version="0.1.0",
        on_list_prompts=list_prompts,
        on_get_prompt=get_prompt,
        on_list_tools=handle_list_tools,
        on_call_tool=handle_call_tool,
    )

    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Gmail API MCP Server')
    parser.add_argument('--creds-file-path',
                        required=True,
                       help='OAuth 2.0 credentials file path')
    parser.add_argument('--token-path',
                        required=True,
                       help='File location to store and retrieve access and refresh tokens for application')
    
    args = parser.parse_args()
    asyncio.run(main(args.creds_file_path, args.token_path))
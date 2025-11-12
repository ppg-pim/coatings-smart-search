"""
Script to upload Excel data to Supabase

Requirements:
pip install pandas openpyxl supabase python-dotenv
"""

import pandas as pd
from supabase import create_client, Client
import os
from typing import List, Dict
import time
import json
import numpy as np
import ssl
import certifi

# Configuration
SUPABASE_URL = "https://odwkuftiedvgvuzypcog.supabase.co"  # Replace with your Supabase project URL
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9kd2t1ZnRpZWR2Z3Z1enlwY29nIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MjUxNTI0OSwiZXhwIjoyMDc4MDkxMjQ5fQ.vjnRxSComqQW3ngSuX_Opnk8x9NBjzUHOk_nRotdZl4"  # Use service_role key for imports
TABLE_NAME = "coatings"  # Replace with your table name
EXCEL_FILE = "Coatings - 6th batch.xlsx"
BATCH_SIZE = 500  # Number of rows to insert at once

# SSL Configuration Options
# Option 1: Use certifi certificates (recommended)
os.environ['SSL_CERT_FILE'] = certifi.where()
os.environ['REQUESTS_CA_BUNDLE'] = certifi.where()

# Option 2: Disable SSL verification (NOT RECOMMENDED for production)
# Uncomment the lines below ONLY if Option 1 doesn't work
# import urllib3
# urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
# os.environ['CURL_CA_BUNDLE'] = ''

# Upload mode options:
# 'insert' - Insert new records only (fails on duplicates)
# 'upsert' - Update existing records or insert new ones
# 'replace' - Delete all existing data and insert new data
UPLOAD_MODE = 'upsert'  # Change this to 'insert', 'upsert', or 'replace'

def clean_data(df: pd.DataFrame) -> pd.DataFrame:
    """Clean and prepare dataframe for upload"""
    print("Cleaning data...")
    
    # Replace NaN, inf, -inf with None
    df = df.replace([np.nan, np.inf, -np.inf], None)
    
    # Also handle any remaining NaN values
    df = df.where(pd.notna(df), None)
    
    # Convert any float columns that are actually integers
    for col in df.columns:
        if df[col].dtype == 'float64':
            # Check if all non-null values are integers
            non_null = df[col].dropna()
            if len(non_null) > 0 and all(non_null == non_null.astype(int)):
                df[col] = df[col].astype('Int64')  # Nullable integer type
    
    # Strip whitespace from string columns
    for col in df.select_dtypes(include=['object']).columns:
        df[col] = df[col].apply(lambda x: x.strip() if isinstance(x, str) else x)
    
    return df

def convert_to_json_safe(obj):
    """Convert objects to JSON-safe format"""
    if pd.isna(obj) or obj is None:
        return None
    elif isinstance(obj, (np.integer, np.floating)):
        if np.isnan(obj) or np.isinf(obj):
            return None
        return obj.item()
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, pd.Timestamp):
        return obj.isoformat()
    else:
        return obj

def prepare_batch(batch: List[Dict]) -> List[Dict]:
    """Prepare batch data to be JSON-safe"""
    cleaned_batch = []
    for row in batch:
        cleaned_row = {}
        for key, value in row.items():
            cleaned_row[key] = convert_to_json_safe(value)
        cleaned_batch.append(cleaned_row)
    return cleaned_batch

def clear_table(supabase: Client, table_name: str):
    """Clear all data from the table"""
    print(f"\n⚠️  WARNING: This will delete ALL data from table '{table_name}'")
    response = input("Are you sure you want to continue? Type 'DELETE ALL' to confirm: ")
    
    if response != 'DELETE ALL':
        print("Table clearing cancelled.")
        return False
    
    try:
        print(f"Deleting all records from '{table_name}'...")
        # Delete all records (using a condition that's always true)
        supabase.table(table_name).delete().neq('sku', '').execute()
        print("✓ Table cleared successfully\n")
        return True
    except Exception as e:
        print(f"✗ Error clearing table: {e}")
        return False

def upload_in_batches(supabase: Client, table_name: str, data: List[Dict], batch_size: int, mode: str = 'insert'):
    """Upload data to Supabase in batches"""
    total_rows = len(data)
    successful = 0
    failed = 0
    updated = 0
    failed_rows = []
    
    mode_text = {
        'insert': 'inserting',
        'upsert': 'upserting',
        'replace': 'inserting'
    }
    
    print(f"Starting upload of {total_rows} rows in batches of {batch_size} (mode: {mode})...")
    
    for i in range(0, total_rows, batch_size):
        batch = data[i:i + batch_size]
        batch_num = (i // batch_size) + 1
        total_batches = (total_rows + batch_size - 1) // batch_size
        
        # Clean the batch before uploading
        cleaned_batch = prepare_batch(batch)
        
        try:
            if mode == 'upsert':
                # Upsert: update if exists, insert if not
                response = supabase.table(table_name).upsert(cleaned_batch).execute()
                successful += len(batch)
                print(f"✓ Batch {batch_num}/{total_batches} upserted successfully ({len(batch)} rows)")
            else:
                # Regular insert
                response = supabase.table(table_name).insert(cleaned_batch).execute()
                successful += len(batch)
                print(f"✓ Batch {batch_num}/{total_batches} uploaded successfully ({len(batch)} rows)")
            
        except Exception as e:
            error_msg = str(e)
            print(f"✗ Batch {batch_num}/{total_batches} failed: {error_msg[:150]}")
            
            # Try inserting rows one by one
            print(f"  Attempting individual row {mode_text[mode]}...")
            for idx, row in enumerate(cleaned_batch):
                try:
                    # Test if row is JSON serializable
                    json.dumps(row)
                    
                    # Upload the row
                    if mode == 'upsert':
                        supabase.table(table_name).upsert(row).execute()
                    else:
                        supabase.table(table_name).insert(row).execute()
                    successful += 1
                    
                except json.JSONDecodeError as json_error:
                    failed += 1
                    row_num = i + idx
                    print(f"  ✗ Row {row_num} - JSON serialization error: {str(json_error)[:100]}")
                    failed_rows.append({'row': row_num, 'error': 'JSON error', 'data': row})
                    
                except Exception as row_error:
                    failed += 1
                    row_num = i + idx
                    error_str = str(row_error)
                    
                    # Check if it's a duplicate key error
                    if '23505' in error_str or 'duplicate key' in error_str.lower():
                        print(f"  ⚠ Row {row_num} - Duplicate SKU: {row.get('sku', 'unknown')}")
                    else:
                        print(f"  ✗ Row {row_num} failed: {error_str[:100]}")
                    
                    failed_rows.append({'row': row_num, 'error': error_str[:200], 'data': row})
        
        # Small delay to avoid rate limiting
        time.sleep(0.1)
    
    print(f"\n{'='*60}")
    print(f"Upload Complete!")
    print(f"Total rows: {total_rows}")
    print(f"Successful: {successful}")
    print(f"Failed: {failed}")
    print(f"{'='*60}")
    
    # Save failed rows to a file for review
    if failed_rows:
        print(f"\nSaving {len(failed_rows)} failed rows to 'failed_rows.json'...")
        with open('failed_rows.json', 'w') as f:
            json.dump(failed_rows, f, indent=2, default=str)
        print("✓ Failed rows saved for review")

def inspect_data_types(df: pd.DataFrame):
    """Inspect data types and potential issues"""
    print("\n" + "="*60)
    print("DATA INSPECTION")
    print("="*60)
    
    print("\nData Types:")
    print(df.dtypes)
    
    print("\nNull/NaN counts per column:")
    null_counts = df.isnull().sum()
    if null_counts.sum() > 0:
        print(null_counts[null_counts > 0])
    else:
        print("No null values found")
    
    print("\nColumns with inf values:")
    inf_found = False
    for col in df.select_dtypes(include=[np.number]).columns:
        inf_count = np.isinf(df[col]).sum()
        if inf_count > 0:
            print(f"  {col}: {inf_count} inf values")
            inf_found = True
    if not inf_found:
        print("  No inf values found")
    
    # Check for duplicate SKUs
    if 'sku' in df.columns:
        dup_count = df['sku'].duplicated().sum()
        print(f"\nDuplicate SKUs in file: {dup_count}")
        if dup_count > 0:
            print("Duplicate SKUs:")
            print(df[df['sku'].duplicated(keep=False)]['sku'].unique()[:10])
    
    print("\n" + "="*60 + "\n")

def main():
    """Main function to orchestrate the upload"""
    
    # Initialize Supabase client
    print("Connecting to Supabase...")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    print("✓ Connected successfully\n")
    
    # Read Excel file
    print(f"Reading Excel file: {EXCEL_FILE}...")
    df = pd.read_excel(EXCEL_FILE)
    print(f"✓ Loaded {len(df)} rows and {len(df.columns)} columns\n")
    
    # Inspect data
    inspect_data_types(df)
    
    # Display first few rows
    print("Preview of data (first 3 rows):")
    print(df.head(3))
    print(f"\nColumns ({len(df.columns)}): {list(df.columns)[:10]}...\n")
    
    # Clean data
    print("Cleaning data...")
    df = clean_data(df)
    print("✓ Data cleaned\n")
    
    # Convert to list of dictionaries
    data = df.to_dict('records')
    
    # Test first row for JSON compatibility
    print("Testing first row for JSON compatibility...")
    try:
        test_row = prepare_batch([data[0]])[0]
        json.dumps(test_row)
        print("✓ First row is JSON compatible\n")
    except Exception as e:
        print(f"✗ First row has issues: {e}")
        print("Problematic row data:")
        print(data[0])
        return
    
    # Handle different upload modes
    print(f"\n{'='*60}")
    print(f"UPLOAD MODE: {UPLOAD_MODE.upper()}")
    print(f"{'='*60}")
    
    if UPLOAD_MODE == 'replace':
        print("This will DELETE all existing data and insert new data.")
        if not clear_table(supabase, TABLE_NAME):
            return
        mode = 'insert'
    elif UPLOAD_MODE == 'upsert':
        print("This will UPDATE existing records and INSERT new ones.")
        mode = 'upsert'
    else:
        print("This will INSERT new records only (will fail on duplicates).")
        mode = 'insert'
    
    # Confirm before upload
    response = input(f"\nReady to upload {len(data)} rows to table '{TABLE_NAME}'. Continue? (yes/no): ")
    if response.lower() != 'yes':
        print("Upload cancelled.")
        return
    
    # Upload data
    upload_in_batches(supabase, TABLE_NAME, data, BATCH_SIZE, mode)

if __name__ == "__main__":
    main()

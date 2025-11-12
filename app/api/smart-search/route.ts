import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import OpenAI from 'openai'

export async function POST(request: NextRequest) {
  console.log('=== Smart Search API Called ===')
  
  try {
    // Check environment variables
    if (!process.env.OPENAI_API_KEY) {
      console.error('Missing OPENAI_API_KEY')
      return NextResponse.json(
        { error: 'OpenAI API key not configured' },
        { status: 500 }
      )
    }

    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      console.error('Missing Supabase credentials')
      return NextResponse.json(
        { error: 'Supabase credentials not configured' },
        { status: 500 }
      )
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })

    // Parse request body
    let query
    try {
      const body = await request.json()
      query = body.query
      console.log('Query received:', query)
    } catch (parseError) {
      console.error('JSON parse error:', parseError)
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      )
    }

    if (!query) {
      return NextResponse.json(
        { error: 'Query is required' },
        { status: 400 }
      )
    }

    // Step 1: Test Supabase connection and get schema
    console.log('Fetching table schema...')
    const { data: sampleData, error: schemaError } = await supabase
      .from('products')
      .select('*')
      .limit(1)

    if (schemaError) {
      console.error('Supabase schema error:', schemaError)
      return NextResponse.json(
        { error: `Database error: ${schemaError.message}` },
        { status: 500 }
      )
    }

    console.log('Sample data:', sampleData)

    const columns = sampleData && sampleData.length > 0 
      ? Object.keys(sampleData[0]) 
      : []

    console.log('Available columns:', columns)

    if (columns.length === 0) {
      return NextResponse.json(
        { error: 'No columns found in products table. Is the table empty?' },
        { status: 500 }
      )
    }

    // Step 2: Use ChatGPT to interpret the query
    console.log('Calling OpenAI...')
    
    let completion
    try {
      completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a database query assistant. Given a natural language query, convert it into a JSON object that describes how to filter a products database.

Available columns: ${columns.join(', ')}

Return a JSON object with this structure:
{
  "filters": [
    {
      "column": "column_name",
      "operator": "eq" | "ilike" | "gt" | "lt" | "gte" | "lte",
      "value": "search_value"
    }
  ],
  "orderBy": {
    "column": "column_name",
    "ascending": true | false
  },
  "limit": 20
}

For text searches, use "ilike" operator with % wildcards (e.g., "%search%").
If no specific filters are needed, return empty filters array to get all products.
Only use columns that exist in the available columns list.`
          },
          {
            role: 'user',
            content: query
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3
      })
    } catch (openaiError: any) {
      console.error('OpenAI error:', openaiError)
      return NextResponse.json(
        { error: `OpenAI error: ${openaiError.message}` },
        { status: 500 }
      )
    }

    console.log('OpenAI response:', completion.choices[0].message.content)

    let searchParams
    try {
      searchParams = JSON.parse(completion.choices[0].message.content || '{}')
    } catch (jsonError) {
      console.error('Failed to parse OpenAI response:', jsonError)
      return NextResponse.json(
        { error: 'Failed to parse search parameters' },
        { status: 500 }
      )
    }

    console.log('Parsed search params:', searchParams)

    // Step 3: Build and execute Supabase query
    let supabaseQuery = supabase.from('products').select('*')

    // Apply filters
    if (searchParams.filters && searchParams.filters.length > 0) {
      searchParams.filters.forEach((filter: any) => {
        const { column, operator, value } = filter
        
        console.log(`Applying filter: ${column} ${operator} ${value}`)
        
        switch (operator) {
          case 'eq':
            supabaseQuery = supabaseQuery.eq(column, value)
            break
          case 'ilike':
            supabaseQuery = supabaseQuery.ilike(column, value)
            break
          case 'gt':
            supabaseQuery = supabaseQuery.gt(column, value)
            break
          case 'lt':
            supabaseQuery = supabaseQuery.lt(column, value)
            break
          case 'gte':
            supabaseQuery = supabaseQuery.gte(column, value)
            break
          case 'lte':
            supabaseQuery = supabaseQuery.lte(column, value)
            break
        }
      })
    }

    // Apply ordering
    if (searchParams.orderBy) {
      console.log(`Ordering by: ${searchParams.orderBy.column}`)
      supabaseQuery = supabaseQuery.order(
        searchParams.orderBy.column,
        { ascending: searchParams.orderBy.ascending }
      )
    }

    // Apply limit
    const limit = searchParams.limit || 20
    supabaseQuery = supabaseQuery.limit(limit)

    // Execute query
    console.log('Executing Supabase query...')
    const { data, error } = await supabaseQuery

    if (error) {
      console.error('Supabase query error:', error)
      return NextResponse.json(
        { error: `Database query error: ${error.message}` },
        { status: 500 }
      )
    }

    console.log(`Query successful. Found ${data?.length || 0} results`)

    return NextResponse.json({
      success: true,
      results: data,
      count: data?.length || 0,
      searchParams: searchParams
    })

  } catch (error: any) {
    console.error('Unexpected error in smart-search:', error)
    return NextResponse.json(
      { 
        error: error.message || 'Internal server error',
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}

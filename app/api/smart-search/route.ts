import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

export async function POST(request: NextRequest) {
  try {
    const { query } = await request.json()

    if (!query) {
      return NextResponse.json(
        { error: 'Query is required' },
        { status: 400 }
      )
    }

    // Step 1: Get your table schema (first time only, or cache this)
    const { data: sampleData, error: schemaError } = await supabase
      .from('products')
      .select('*')
      .limit(1)

    if (schemaError) {
      throw new Error(`Schema error: ${schemaError.message}`)
    }

    const columns = sampleData && sampleData.length > 0 
      ? Object.keys(sampleData[0]) 
      : []

    // Step 2: Use ChatGPT to interpret the query
    const completion = await openai.chat.completions.create({
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
  "limit": number
}

For text searches, use "ilike" operator with % wildcards.
If no specific filters are needed, return empty filters array to get all products.`
        },
        {
          role: 'user',
          content: query
        }
      ],
      response_format: { type: 'json_object' }
    })

    const searchParams = JSON.parse(completion.choices[0].message.content || '{}')

    // Step 3: Build and execute Supabase query
    let supabaseQuery = supabase.from('products').select('*')

    // Apply filters
    if (searchParams.filters && searchParams.filters.length > 0) {
      searchParams.filters.forEach((filter: any) => {
        const { column, operator, value } = filter
        
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
      supabaseQuery = supabaseQuery.order(
        searchParams.orderBy.column,
        { ascending: searchParams.orderBy.ascending }
      )
    }

    // Apply limit
    const limit = searchParams.limit || 20
    supabaseQuery = supabaseQuery.limit(limit)

    // Execute query
    const { data, error } = await supabaseQuery

    if (error) {
      throw new Error(`Database error: ${error.message}`)
    }

    return NextResponse.json({
      success: true,
      results: data,
      count: data?.length || 0,
      searchParams: searchParams
    })

  } catch (error: any) {
    console.error('Smart search error:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}

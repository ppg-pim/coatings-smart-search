import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import OpenAI from 'openai'

// Remove this - don't instantiate at module level
// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY,
// })

export async function POST(request: NextRequest) {
  try {
    const { query } = await request.json()

    if (!query) {
      return NextResponse.json(
        { error: 'Query is required' },
        { status: 400 }
      )
    }

    // Initialize OpenAI inside the function (runtime)
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })

    // Get AI interpretation
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `You are a helpful assistant that interprets search queries for a coatings product database.
Extract search criteria and return a JSON object with filters.
Available fields: product_name, product_line, category, substrate, color, finish, application_method, cure_type, voc_level, features.
Return format: { "filters": [{ "column": "field_name", "operator": "eq|ilike|contains", "value": "search_value" }] }`,
        },
        {
          role: 'user',
          content: query,
        },
      ],
      temperature: 0.3,
    })

    const aiResponse = completion.choices[0].message.content
    let filters = []

    try {
      const parsed = JSON.parse(aiResponse || '{}')
      filters = parsed.filters || []
    } catch (e) {
      console.error('Failed to parse AI response:', e)
    }

    // Build Supabase query
    let supabaseQuery: any = supabase
      .from('products')
      .select('*')

    // Apply filters
    for (const filter of filters) {
      const { column, operator, value } = filter

      switch (operator) {
        case 'eq':
          supabaseQuery = supabaseQuery.eq(column, value)
          break
        case 'ilike':
          supabaseQuery = supabaseQuery.ilike(column, `%${value}%`)
          break
        case 'contains':
          supabaseQuery = supabaseQuery.contains(column, [value])
          break
      }
    }

    const { data: products, error } = await supabaseQuery

    if (error) {
      console.error('Supabase error:', error)
      return NextResponse.json(
        { error: 'Database query failed', details: error.message },
        { status: 500 }
      )
    }

    return NextResponse.json({
      products: products || [],
      filters: filters,
      interpretation: aiResponse,
    })
  } catch (error: any) {
    console.error('Search error:', error)
    return NextResponse.json(
      { error: 'Search failed', details: error.message },
      { status: 500 }
    )
  }
}

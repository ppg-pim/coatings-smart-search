import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const query = searchParams.get('query') || ''
    const family = searchParams.get('family')
    const productType = searchParams.get('productType')
    const productModel = searchParams.get('productModel')
    const limit = parseInt(searchParams.get('limit') || '50')

    console.log('🔍 Search params:', { query, family, productType, productModel, limit })

    // Start building the query
    let supabaseQuery = supabase
      .from('coatings')
      .select('*')

    // Apply filters
    if (family) {
      supabaseQuery = supabaseQuery.eq('family', family)
    }
    if (productType) {
      supabaseQuery = supabaseQuery.eq('Product_Type', productType)
    }
    if (productModel) {
      supabaseQuery = supabaseQuery.eq('Product_Model', productModel)
    }

    // Apply text search if query exists
    if (query.trim()) {
      supabaseQuery = supabaseQuery.or(`Product_Name.ilike.%${query}%,family.ilike.%${query}%,Product_Type.ilike.%${query}%`)
    }

    // Apply limit
    supabaseQuery = supabaseQuery.limit(limit)

    const { data, error } = await supabaseQuery

    if (error) throw error

    console.log(`✅ Found ${data?.length || 0} results`)

    return NextResponse.json({
      success: true,
      results: data || [],
      count: data?.length || 0
    })

  } catch (error: any) {
    console.error('❌ Error in search API:', error)
    return NextResponse.json(
      { 
        success: false,
        error: error.message,
        results: []
      },
      { status: 500 }
    )
  }
}

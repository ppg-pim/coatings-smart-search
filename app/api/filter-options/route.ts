import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// Cache for 1 hour (revalidate every 3600 seconds)
export const revalidate = 3600

export async function GET() {
  try {
    console.log('🚀 GET /api/filter-options - Loading filter options...')
    const startTime = Date.now()

    const { data, error } = await supabaseAdmin
      .from('filter_options')
      .select('*')
      .single()

    if (error) throw error

    const duration = Date.now() - startTime
    const families = data.families || []
    const productTypes = data.product_types || []
    const productModels = data.product_models || []

    console.log(`✅ Found ${families.length} families, ${productTypes.length} types, ${productModels.length} models in ${duration}ms`)

    return NextResponse.json({
      success: true,
      families,
      productTypes,
      productModels
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200'
      }
    })

  } catch (error: any) {
    console.error('❌ Error in filter-options API:', error)
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    )
  }
}

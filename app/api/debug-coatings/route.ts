import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET() {
  try {
    console.log('=== COATING STRUCTURE DEBUG ===')
    
    // Try different query approaches
    const { data: coatings1, error: error1, count } = await supabase
      .from('coatings')
      .select('*', { count: 'exact' })
      .limit(5)

    console.log('Query 1 - Basic select:')
    console.log('  Count:', count)
    console.log('  Fetched:', coatings1?.length || 0)
    console.log('  Error:', error1)

    if (coatings1 && coatings1.length > 0) {
      console.log('  First coating keys:', Object.keys(coatings1[0]))
      console.log('  First coating sample:', JSON.stringify(coatings1[0], null, 2).slice(0, 500))
    }

    // Try without count
    const { data: coatings2, error: error2 } = await supabase
      .from('coatings')
      .select('*')
      .limit(5)

    console.log('\nQuery 2 - Without count:')
    console.log('  Fetched:', coatings2?.length || 0)
    console.log('  Error:', error2)

    const sampleCoating = coatings1?.[0] || coatings2?.[0] || null
    const allFieldNames = sampleCoating ? Object.keys(sampleCoating) : []

    return NextResponse.json({
      success: true,
      totalCoatings: coatings1?.length || coatings2?.length || 0,
      totalInDB: count,
      sampleCoating,
      allFieldNames,
      errors: {
        query1: error1?.message,
        query2: error2?.message
      }
    })

  } catch (error: any) {
    console.error('❌ Debug endpoint error:', error)
    return NextResponse.json(
      { 
        success: false,
        error: error.message,
        stack: error.stack
      },
      { status: 500 }
    )
  }
}

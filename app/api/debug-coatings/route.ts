import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET() {
  try {
    // Fetch first 10 coatings to inspect structure
    const { data: coatings, error } = await supabase
      .from('coatings')
      .select('*')
      .limit(10)

    if (error) {
      throw new Error(`Database error: ${error.message}`)
    }

    console.log('=== COATING STRUCTURE DEBUG ===')
    console.log('Total coatings fetched:', coatings?.length)
    
    if (coatings && coatings.length > 0) {
      console.log('\n=== FIRST COATING ===')
      console.log(JSON.stringify(coatings[0], null, 2))
      
      console.log('\n=== ALL FIELD NAMES ===')
      console.log(Object.keys(coatings[0]))
      
      // Check for family fields
      console.log('\n=== FAMILY FIELDS ===')
      const firstCoating = coatings[0]
      console.log('family:', firstCoating.family)
      console.log('Family:', firstCoating.Family)
      console.log('product_family:', firstCoating.product_family)
      console.log('productFamily:', firstCoating.productFamily)
      
      // Check for type fields
      console.log('\n=== TYPE FIELDS ===')
      console.log('product_type:', firstCoating.product_type)
      console.log('productType:', firstCoating.productType)
      console.log('type:', firstCoating.type)
      console.log('Type:', firstCoating.Type)
      
      // Check for model fields
      console.log('\n=== MODEL FIELDS ===')
      console.log('product_model:', firstCoating.product_model)
      console.log('productModel:', firstCoating.productModel)
      console.log('model:', firstCoating.model)
      console.log('Model:', firstCoating.Model)
      
      // Check all_attributes
      if (firstCoating.all_attributes) {
        console.log('\n=== ALL_ATTRIBUTES ===')
        const attr = typeof firstCoating.all_attributes === 'string' 
          ? JSON.parse(firstCoating.all_attributes) 
          : firstCoating.all_attributes
        console.log(JSON.stringify(attr, null, 2))
      }
    }

    return NextResponse.json({
      success: true,
      totalCoatings: coatings?.length || 0,
      sampleCoating: coatings?.[0] || null,
      allFieldNames: coatings?.[0] ? Object.keys(coatings[0]) : []
    })

  } catch (error: any) {
    console.error('❌ Debug error:', error)
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    )
  }
}
